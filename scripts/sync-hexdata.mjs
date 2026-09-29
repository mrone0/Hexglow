import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ORIGIN = "https://hexdata.com.cn";
const ROUTES = ["/heroes", "/augments", "/items"];
const OUTPUT = resolve(".local-data", "hexdata");
const USER_AGENT = "HexglowLocalDataSync/0.1 (+local personal cache)";
// The site rate-limits aggressively (HTTP 429 observed even for ~1 req/s bursts);
// keep detail fetching serial and slow, and reuse matching detail data on re-runs.
// HEXDATA_SYNC_DELAY_MS overrides the base per-request delay (milliseconds).
const DETAIL_CONCURRENCY = 1;
const DETAIL_DELAY_MS = Math.max(1000, Number(process.env.HEXDATA_SYNC_DELAY_MS) || 6000);
const DELAY_MAX_MS = Math.max(DETAIL_DELAY_MS * 3, 30000);
const MAX_ATTEMPTS = 3;
const MAX_429_ATTEMPTS = 3;
const FOUR29_WAIT_MS = 45000;
// This site answers 429s with an explicit Retry-After; long windows mean an
// anti-abuse cooldown where retrying only extends the penalty. Abort instead.
const LONG_RETRY_AFTER_S = 600;
const FORCE = process.argv.includes("--force");
// Bump when a parser fix invalidates previously cached detail records.
const PARSER_VERSION = 3;

// Adaptive pacing: double the delay on 429 (site-wide limit), ease back down on
// success so a cold bucket refills without stalling a warm one.
const pacing = { delayMs: DETAIL_DELAY_MS };

function note429() {
  pacing.delayMs = Math.min(Math.round(pacing.delayMs * 1.5), DELAY_MAX_MS);
}

function noteSuccess() {
  pacing.delayMs = Math.max(DETAIL_DELAY_MS, Math.round(pacing.delayMs * 0.95));
}

function decode(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x?[0-9a-f]+);/gi, (_, value) =>
      String.fromCodePoint(parseInt(value.replace(/^x/i, ""), /^x/i.test(value) ? 16 : 10)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(markup, name) {
  return markup.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] ?? null;
}

function meta(html, name) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
  return tag ? attr(tag, "content") : null;
}

function publicRules(robots) {
  const rules = [];
  let applies = false;
  for (const source of robots.split(/\r?\n/)) {
    const line = source.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*";
    else if (applies && (key === "allow" || key === "disallow")) rules.push({ type: key, path: value });
  }
  return rules;
}

function isAllowed(path, rules) {
  const matches = rules.filter((rule) => rule.path && path.startsWith(rule.path));
  if (!matches.length) return true;
  matches.sort((a, b) => b.path.length - a.path.length || (a.type === "allow" ? -1 : 1));
  return matches[0].type === "allow";
}

async function request(path) {
  const response = await fetch(`${ORIGIN}${path}`, {
    headers: { Accept: "text/html, text/plain;q=0.9", "User-Agent": USER_AGENT },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0) || 0;
      const error = new Error(`${path}: HTTP 429 (Retry-After ${retryAfter}s)`);
      error.retryAfter = retryAfter;
      throw error;
    }
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}

async function requestWithRetry(path, rules) {
  if (!isAllowed(path, rules)) throw new Error(`robots.txt 不允许抓取 ${path}`);
  let lastError;
  for (let attempt = 1; attempt <= MAX_429_ATTEMPTS; attempt++) {
    try {
      return await request(path);
    } catch (error) {
      lastError = error;
      if (error.retryAfter > LONG_RETRY_AFTER_S) throw error;
      const saw429 = String(error).includes("HTTP 429");
      if (saw429) note429();
      if (attempt >= (saw429 ? MAX_429_ATTEMPTS : MAX_ATTEMPTS)) break;
      await new Promise((r) => setTimeout(r, saw429 ? FOUR29_WAIT_MS : 1000 * attempt));
    }
  }
  throw lastError;
}

async function pool(items, worker, { concurrency = DETAIL_CONCURRENCY, getDelay = () => DETAIL_DELAY_MS } = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      if (index > 0) {
        const delayMs = getDelay();
        await new Promise((r) => setTimeout(r, delayMs + Math.random() * delayMs * 0.5));
      }
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function table(html) {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!body) throw new Error("页面中未找到榜单表格");
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((cell) => ({
      text: decode(cell[1]),
      href: cell[1].match(/<a[^>]+href=["']([^"']+)["']/i)?.[1] ?? null,
    })),
  );
}

function tables(scopeHtml) {
  return [...scopeHtml.matchAll(/<table>([\s\S]*?)<\/table>/gi)]
    .map(([, markup]) => {
      const headers = [...markup.matchAll(/<th>([\s\S]*?)<\/th>/gi)].map((cell) => decode(cell[1]));
      const body = markup.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1];
      if (!body) return { headers: [], rows: [] };
      const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((row) =>
        [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((cell) => ({
          text: decode(cell[1]),
          href: cell[1].match(/<a[^>]+href=["']([^"']+)["']/i)?.[1] ?? null,
        })),
      );
      return { headers, rows };
    })
    .filter((table) => table.rows.length > 0);
}

function answerBodyFrom(html) {
  // The conclusion block lives after the source-note aside, outside the primary
  // content section, so it must be extracted from the whole document.
  return decode(html.match(/<div class="seo-answer-body">([\s\S]*?)<\/div>/i)?.[1] ?? "");
}

function primaryContent(html) {
  return html.match(/<section data-primary-content>([\s\S]*?)<\/section>\s*<aside/i)?.[1] ?? "";
}

function ldJsonBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .map(([, text]) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function faqAnswers(html) {
  return ldJsonBlocks(html)
    .filter((block) => block["@type"] === "FAQPage")
    .flatMap((block) => block.mainEntity ?? [])
    .map((question) => ({
      name: question.name ?? "",
      text: question.acceptedAnswer?.text ?? "",
    }));
}

function number(text, pattern) {
  const value = text.match(pattern)?.[1];
  return value === undefined ? null : Number(value.replaceAll(",", ""));
}

function parseHeroes(rows) {
  return rows.map(([name, metrics]) => {
    const route = name.href;
    const match = route?.match(/^\/hero\/(\d+)-(.+)$/);
    if (!match) throw new Error(`无法解析英雄链接：${route}`);
    return {
      key: `hero:${match[1]}`,
      id: Number(match[1]),
      slug: match[2],
      name: name.text,
      winRate: number(metrics.text, /胜率\s*([\d.]+)%/),
      samples: number(metrics.text, /样本\s*([\d,]+)/),
      sourceUrl: `${ORIGIN}${route}`,
    };
  });
}

function parseAugments(rows) {
  return rows.map(([name, metrics]) => {
    const route = name.href;
    const match = route?.match(/^\/augment\/(\d+)-(.+)$/);
    if (!match) throw new Error(`无法解析海克斯链接：${route}`);
    return {
      key: `augment:${match[1]}`,
      id: Number(match[1]),
      slug: match[2],
      name: name.text,
      score: number(metrics.text, /综合评分\s*([\d.]+)/),
      winRate: number(metrics.text, /胜率\s*([\d.]+)%/),
      sourceUrl: `${ORIGIN}${route}`,
    };
  });
}

function parseItems(rows) {
  return rows.map(([name, metrics, coverage, topHero]) => {
    const route = name.href;
    const match = route?.match(/^\/item\/(\d+)$/);
    if (!match) throw new Error(`无法解析装备链接：${route}`);
    return {
      key: `item:${match[1]}:${name.text}`,
      id: Number(match[1]),
      name: name.text,
      score: number(metrics.text, /HexScore\s*([\d.]+)/),
      winRate: number(metrics.text, /胜率\s*([\d.]+)%/),
      samples: number(metrics.text, /样本\s*([\d,]+)/),
      championCoverage: number(coverage.text, /([\d,]+)/),
      topSampleHero: topHero.text.replace(/出装$/, ""),
      topSampleHeroUrl: topHero.href ? `${ORIGIN}${topHero.href}` : null,
      sourceUrl: `${ORIGIN}${route}`,
    };
  });
}

function pageMeta(html, route) {
  const description = meta(html, "description") ?? "";
  return {
    sourceUrl: `${ORIGIN}${route}`,
    patch: description.match(/Patch\s+([\d.]+)/i)?.[1] ?? null,
    reportDate: meta(html, "hexdata-report-date"),
    generatedAt: meta(html, "hexdata-generated-at"),
    buildId: meta(html, "hexdata-build-id"),
    description,
  };
}

// Detail tables carry bare values under labeled headers (HexScore / 胜率 / 样本),
// unlike the index pages whose cells embed their own labels.
function statRowFrom(table, row) {
  const match = row[0]?.href?.match(/^\/(hero|augment|item)\/(\d+)(?:-(.+))?$/);
  if (!match) return null;
  const column = (label) => {
    const index = table.headers.findIndex((header) => header.includes(label));
    return index >= 0 ? row[index] : null;
  };
  const value = (cell, pattern) => {
    const raw = cell?.text.match(pattern)?.[1];
    return raw === undefined ? null : Number(raw.replaceAll(",", ""));
  };
  return {
    id: Number(match[2]),
    slug: match[3] ?? null,
    name: row[0].text,
    hexScore: value(column("HexScore"), /([\d.]+)/),
    winRate: value(column("胜率"), /([\d.]+)/),
    samples: value(column("样本"), /([\d,]+)/),
  };
}

function effectTextFromGuide(scopeHtml) {
  const guide = scopeHtml.match(/<section class="seo-guide-section"[\s\S]*?<\/section>/i)?.[0];
  const paragraph = guide?.match(/<p>([\s\S]*?)<\/p>/i)?.[1];
  if (!paragraph) return null;
  let text = decode(paragraph);
  if (!text.includes("这类高分高样本英雄上考虑。")) return null;
  text = text.replace(/^.*?这类高分高样本英雄上考虑。\s*/, "");
  const cutoff = text.indexOf("如果你的英雄机制能稳定触发这个海克斯");
  if (cutoff >= 0) text = text.slice(0, cutoff);
  text = text.trim();
  return text || null;
}

function relativeGain(answerText, marker) {
  const index = answerText.indexOf(marker);
  if (index < 0) return null;
  return number(answerText.slice(index, index + 60), /基准收益\s*[+＋]?\s*(-?[\d.]+)%/);
}

function parseAugmentDetail(html, route) {
  const info = pageMeta(html, route);
  const scope = primaryContent(html);
  const [fitTable] = tables(scope);
  const answers = faqAnswers(html);
  const scoreAnswer = answers.map((a) => a.text).find((text) => text.includes("综合评分")) ?? "";
  const answerBody = answerBodyFrom(html);
  return {
    ...info,
    description: undefined,
    score: number(scoreAnswer, /综合评分\s*([\d.]+)/),
    winRate: number(info.description, /胜率\s*([\d.]+)%/),
    pickRate: number(info.description, /选取率\s*([\d.]+)%/),
    samples: number(info.description, /样本\s*([\d,]+)\s*场/),
    heroCoverage: number(info.description, /覆盖\s*([\d,]+)\s*位英雄/),
    effectText: effectTextFromGuide(scope),
    topHeroRelativeGain: relativeGain(answerBody, "相对该英雄基准收益"),
    heroes: (fitTable?.rows ?? []).map((row) => statRowFrom(fitTable, row)).filter(Boolean),
  };
}

function parseHeroDetail(html, route) {
  const info = pageMeta(html, route);
  const scope = primaryContent(html);
  const [augmentTable, itemTable] = tables(scope);
  const answerBody = answerBodyFrom(html);
  const relatedLabel = scope.match(/<p data-seo-related-heroes>同定位英雄（(.+?)）<\/p>/)?.[1] ?? null;
  const rolesMatch = answerBody.match(/主要定位是(.+?)。/)?.[1];
  const otherNamesMatch = info.description.match(/其他常用名[:：]\s*([^。]+?)。/)?.[1];
  return {
    ...info,
    description: undefined,
    tier: info.description.match(/层级\s*(T\d+)/)?.[1] ?? null,
    roles: rolesMatch
      ? rolesMatch.split("、").filter(Boolean)
      : relatedLabel
        ? [relatedLabel]
        : [],
    otherNames: otherNamesMatch ? otherNamesMatch.split("、").map((s) => s.trim()).filter(Boolean) : [],
    winRate: number(info.description, /胜率\s*([\d.]+)%/),
    samples: number(info.description, /样本\s*([\d,]+)\s*场/),
    topAugmentRelativeGain: relativeGain(answerBody, "相对英雄基准收益"),
    augments: (augmentTable?.rows ?? []).map((row) => statRowFrom(augmentTable, row)).filter(Boolean),
    items: (itemTable?.rows ?? []).map((row) => statRowFrom(itemTable, row)).filter(Boolean),
  };
}

const robots = await request("/robots.txt");
const rules = publicRules(robots);
for (const route of ROUTES) {
  if (!isAllowed(route, rules)) throw new Error(`robots.txt 不允许抓取 ${route}`);
}

const parsers = { "/heroes": parseHeroes, "/augments": parseAugments, "/items": parseItems };
const result = {};
for (const route of ROUTES) {
  const html = await request(route);
  const key = route.slice(1);
  const records = parsers[route](table(html));
  result[key] = { ...pageMeta(html, route), count: records.length, records };
}

// Detail pages: per-hero and per-augment attributes (robots-checked, rate-limited).
// Data already cached for the same patch + report date is reused unless --force.
const detailRecords = { heroes: {}, augments: {} };
const detailFailures = [];
if (!FORCE) {
  for (const kind of ["heroes", "augments"]) {
    try {
      const existing = JSON.parse(await readFile(resolve(OUTPUT, `${kind}-detail.json`), "utf8"));
      if (
        existing.parserVersion === PARSER_VERSION &&
        existing.patch === result[kind].patch &&
        existing.reportDate === result[kind].reportDate
      ) {
        detailRecords[kind] = { ...existing.records };
      }
    } catch {
      // no previous cache for this kind
    }
  }
}
const detailTasks = [
  // Augments first: they are the knowledge docs most consulted during draft, so a
  // partial sync still covers the primary use case before hero details complete.
  ...result.augments.records
    .map((record) => ({ kind: "augments", path: new URL(record.sourceUrl).pathname, id: record.id }))
    .filter((task) => detailRecords.augments[String(task.id)] === undefined),
  ...result.heroes.records
    .map((record) => ({ kind: "heroes", path: new URL(record.sourceUrl).pathname, id: record.id }))
    .filter((task) => detailRecords.heroes[String(task.id)] === undefined),
];
const detailTotal = Object.keys(detailRecords.heroes).length + Object.keys(detailRecords.augments).length + detailTasks.length;
let detailDone = detailTotal - detailTasks.length;
const startedAt = Date.now();
let cooldownAbort = null;
async function flushDetails() {
  for (const kind of ["heroes", "augments"]) {
    const payload = {
      fetchedAt: new Date().toISOString(),
      parserVersion: PARSER_VERSION,
      patch: result[kind].patch,
      reportDate: result[kind].reportDate,
      records: detailRecords[kind],
    };
    await writeFile(resolve(OUTPUT, `${kind}-detail.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
await pool(
  detailTasks,
  async (task) => {
    if (cooldownAbort) return;
    try {
      const html = await requestWithRetry(task.path, rules);
      noteSuccess();
      detailRecords[task.kind][String(task.id)] =
        task.kind === "heroes" ? parseHeroDetail(html, task.path) : parseAugmentDetail(html, task.path);
    } catch (error) {
      if (error.retryAfter > LONG_RETRY_AFTER_S) {
        cooldownAbort = error;
        return;
      }
      detailFailures.push({ kind: task.kind, id: task.id, path: task.path, reason: String(error) });
    }
    detailDone += 1;
    if (detailDone % 10 === 0) {
      console.log(
        `detail pages: ${detailDone}/${detailTotal} (${Math.round((Date.now() - startedAt) / 1000)}s, delay ${pacing.delayMs}ms)`,
      );
      await flushDetails();
    }
  },
  { getDelay: () => pacing.delayMs },
);

if (cooldownAbort) {
  await flushDetails();
  const resumeAt = new Date(Date.now() + cooldownAbort.retryAfter * 1000).toLocaleString("zh-CN");
  console.error(`Hexdata 返回长冷却窗口：${cooldownAbort.message}`);
  console.error(`已完成部分已写入 .local-data/hexdata/*-detail.json；约 ${resumeAt} 后重跑 npm run data:sync 续传。`);
  process.exit(2);
}

const fetchedAt = new Date().toISOString();
const manifest = {
  fetchedAt,
  source: ORIGIN,
  methodology: `${ORIGIN}/methodology`,
  license: `${ORIGIN}/methodology#data-license`,
  usage: "仅供本机个人查询缓存；整批转载或商业使用前需取得 Hexdata 许可。",
  datasets: Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      { count: value.count, patch: value.patch, reportDate: value.reportDate, file: `${key}.json` },
    ]).concat([
      ["heroes-detail", { count: Object.keys(detailRecords.heroes).length, patch: result.heroes.patch, reportDate: result.heroes.reportDate, file: "heroes-detail.json" }],
      ["augments-detail", { count: Object.keys(detailRecords.augments).length, patch: result.augments.patch, reportDate: result.augments.reportDate, file: "augments-detail.json" }],
    ]),
  ),
  detailFailures,
};

await mkdir(OUTPUT, { recursive: true });
for (const [key, value] of Object.entries(result)) {
  await writeFile(resolve(OUTPUT, `${key}.json`), `${JSON.stringify({ fetchedAt, ...value }, null, 2)}\n`, "utf8");
}
await flushDetails();
await writeFile(resolve(OUTPUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

for (const [key, value] of Object.entries(result)) console.log(`${key}: ${value.count}`);
console.log(`heroes-detail: ${Object.keys(detailRecords.heroes).length} (failed: ${detailFailures.filter((f) => f.kind === "heroes").length})`);
console.log(`augments-detail: ${Object.keys(detailRecords.augments).length} (failed: ${detailFailures.filter((f) => f.kind === "augments").length})`);
console.log(`saved: ${OUTPUT}`);
