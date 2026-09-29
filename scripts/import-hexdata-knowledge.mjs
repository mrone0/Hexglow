import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CACHE = resolve(".local-data", "hexdata");
const SEED = resolve("knowledge-seed");
const CATALOG = resolve("src-tauri", "src", "knowledge_seed_catalog.rs");

async function json(name) {
  return JSON.parse(await readFile(resolve(CACHE, `${name}.json`), "utf8"));
}

async function jsonOrNull(name) {
  try {
    return await json(name);
  } catch {
    console.warn(`warn: ${name}.json 缺失，相关章节将退回占位文本（先运行 npm run data:sync）`);
    return null;
  }
}

function yaml(value) {
  return JSON.stringify(value);
}

// FNV-1a 64-bit, matching src-tauri/src/knowledge.rs hash(): deterministic cache hint,
// used by the v3 seed migration to recognize pristine generated docs (never user edits).
function fnv1a64(text) {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function int(value) {
  return value === null || value === undefined ? null : Number(value);
}

function fmt(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function fmtSamples(value) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");
}

function championNames(label, slug) {
  const match = label.match(/^(.*?)（(.*?)）$/);
  const title = match?.[2] || label;
  const epithet = match?.[1] || "";
  return { title, epithet, aliases: [...new Set([slug, epithet, label].filter(Boolean))] };
}

function statTable(rows, pathFor) {
  const body = rows
    .map((row) => {
      const target = pathFor(row);
      const name = target ? `[${row.name}](${target})` : row.name;
      const winRate = row.winRate === null || row.winRate === undefined ? "—" : `${row.winRate}%`;
      return `| ${name} | ${fmt(row.hexScore)} | ${winRate} | ${fmtSamples(row.samples)} |`;
    })
    .join("\n");
  return `| 名称 | HexScore | 胜率 | 样本 |\n| --- | --- | --- | --- |\n${body}`;
}

function augmentDoc(record, dataset, augmentId, detail, heroSlugSet) {
  const effect = detail?.effectText
    ? `${detail.effectText}\n\n> 以上为 Hexdata 详情页导语的效果摘录，非官方原文；触发与数值以游戏内为准。`
    : "尚未从可再分发的原始静态数据源补充，不能据此推断具体数值或机制。";
  const limits = detail
    ? `全局综合评分 ${fmt(detail.score ?? record.score)}，全局胜率 ${fmt(detail.winRate ?? record.winRate)}%，选取率 ${fmt(detail.pickRate)}%，样本 ${fmtSamples(detail.samples)} 场，覆盖 ${fmt(detail.heroCoverage)} 位英雄。这些指标仅适合同模式、同版本横向比较，不代表该海克斯对任意英雄都有相同效果。`
    : `全局综合评分 ${record.score}，全局胜率 ${record.winRate}%。这些指标仅适合同模式、同版本横向比较，不代表该海克斯对任意英雄都有相同效果。`;
  const heroTable = detail?.heroes?.length
    ? `适配英雄（HexScore 降序，搭配胜率 / 样本）：\n\n${statTable(detail.heroes, (row) => (row.slug && heroSlugSet.has(row.slug) ? `../champions/${row.slug}.md` : null))}`
    : "该详情页未提供适配英雄明细。";
  const topHero = detail?.heroes?.[0];
  const topHeroNote =
    topHero && detail.topHeroRelativeGain !== null && detail.topHeroRelativeGain !== undefined
      ? `首位适配英雄 ${topHero.name} 相对其自身基准收益 ${detail.topHeroRelativeGain > 0 ? "+" : ""}${detail.topHeroRelativeGain}%（搭配样本 ${fmtSamples(topHero.samples)} 场）。`
      : null;
  return `---
title: ${yaml(record.name)}
description: ${yaml(detail ? `${record.name}的海克斯大乱斗榜单索引：全局属性与适配英雄统计（Patch ${dataset.patch}）。` : `${record.name}的海克斯大乱斗全局榜单索引；尚未包含完整效果文本。`)}
tags: [augment, hexdata, statistics]
status: draft
type: Augment
hexglow:
  schema_version: 1
  mode: hextech-aram
  patch: ${yaml(dataset.patch)}
  augment_id: ${augmentId}
  game_id: ${record.id}
  aliases: ${yaml([augmentId])}
---
# ${record.name}

> 本文由 Hexdata 公开榜单与详情页导入（Patch ${dataset.patch}，数据日期 ${detail?.reportDate ?? dataset.reportDate}）；统计为聚合观察值，不代表因果关系。

## 完整效果
${effect}

## 触发条件
${detail ? "待核实：详情页未提供触发条件文本；出现时机与限制请以游戏内三选一说明为准。" : "待核实。"}

## 限制与例外
${limits}

## 相关交互
${heroTable}
${topHeroNote ? `\n${topHeroNote}\n` : ""}
- 数据版本：Patch ${dataset.patch}
- 统计日期：${detail?.reportDate ?? dataset.reportDate}
- 来源：[Hexdata · ${record.name}](${record.sourceUrl})
- 状态为草稿；实际选择前仍需核对游戏内效果和当前阵容。
`;
}

function championDoc(record, dataset, detail, augmentFileById, otherNames) {
  const { title, aliases } = championNames(record.name, record.slug);
  const frontAliases = [...new Set([...aliases, ...otherNames])];
  const profile = detail
    ? `页面未提供技能与机制说明；请勿根据本段推断英雄机制。已知基础属性：定位 ${detail.roles.length ? detail.roles.join("、") : "未标注"}；当前层级 ${fmt(detail.tier)}${otherNames.length ? `；其他常用名：${otherNames.join("、")}` : ""}。`
    : "尚未导入技能与机制资料；请勿根据本段推断英雄机制。";
  const winRate = fmt(detail?.winRate ?? record.winRate);
  const samples = fmtSamples(detail?.samples ?? record.samples);
  const items = detail?.items?.length
    ? `出装排行（HexScore 降序，前 ${detail.items.length} 件）：\n\n${statTable(detail.items, () => null)}\n\n不同阵容、经济与样本量不能直接类推。`
    : "该详情页未提供出装排行明细。";
  const augmentTable = detail?.augments?.length
    ? `推荐海克斯（HexScore 降序）：\n\n${statTable(detail.augments, (row) => (row.id && augmentFileById.get(row.id) ? `../augments/${augmentFileById.get(row.id)}` : null))}${detail.topAugmentRelativeGain !== null && detail.topAugmentRelativeGain !== undefined ? `\n\n首位推荐 ${detail.augments[0].name} 相对该英雄基准收益 ${detail.topAugmentRelativeGain > 0 ? "+" : ""}${detail.topAugmentRelativeGain}%。` : ""}`
    : "该详情页未提供逐个海克斯的英雄搭配明细。";
  return `---
title: ${yaml(title)}
description: ${yaml(`${record.name}的海克斯大乱斗榜单索引：基础属性、出装与推荐海克斯统计（Patch ${dataset.patch}）。`)}
tags: [champion, hexdata, statistics]
status: draft
type: Champion
hexglow:
  schema_version: 1
  mode: hextech-aram
  patch: ${yaml(dataset.patch)}
  champion_id: ${record.slug}
  game_id: ${record.id}
  aliases: ${yaml(frontAliases)}
---
# ${title}

> 本文由 Hexdata 公开榜单与详情页导入，只记录 Patch ${dataset.patch} 的聚合统计，不代表因果关系，也不是英雄机制说明。

## 基础机制
${profile}

## 常见打法
公开榜单统计：胜率 ${winRate}% ，样本 ${samples}。不同阵容、玩家与版本不能直接类推。

${items}

## 海克斯搭配
${augmentTable}

## 注意事项
- 数据版本：Patch ${dataset.patch}
- 统计日期：${detail?.reportDate ?? dataset.reportDate}
- 来源：[Hexdata · ${record.name}](${record.sourceUrl})
- 状态为草稿；推荐时只能作为弱统计信号，不能替代当前阵容、候选效果与玩家判断。
`;
}

const [heroes, augments, heroesDetail, augmentsDetail] = await Promise.all([
  json("heroes"),
  json("augments"),
  jsonOrNull("heroes-detail"),
  jsonOrNull("augments-detail"),
]);
if (!heroes.records?.length || !augments.records?.length) {
  throw new Error("本机缓存为空，请先运行 npm run data:sync");
}
const heroDetailById = new Map(Object.entries(heroesDetail?.records ?? {}).map(([id, value]) => [Number(id), value]));
const augmentDetailById = new Map(Object.entries(augmentsDetail?.records ?? {}).map(([id, value]) => [Number(id), value]));

await Promise.all([
  mkdir(resolve(SEED, "champions"), { recursive: true }),
  mkdir(resolve(SEED, "augments"), { recursive: true }),
]);

// Snapshot the previous seed generation before overwriting: the catalog embeds each
// path's previous content hash so the Rust v3 migration can refresh pristine generated
// docs while never touching user-edited ones.
const previousHashes = new Map();
for (const directory of ["champions", "augments"]) {
  for (const file of (await readdir(resolve(SEED, directory))).filter((name) => name.endsWith(".md"))) {
    const path = `${directory}/${file}`;
    previousHashes.set(path, fnv1a64(await readFile(resolve(SEED, directory, file), "utf8")));
  }
}

const heroSlugSet = new Set(heroes.records.map((record) => record.slug));
const slugCounts = new Map();
for (const record of augments.records) slugCounts.set(record.slug, (slugCounts.get(record.slug) || 0) + 1);
const slugSeen = new Map();
const augmentFileById = new Map();
for (const record of augments.records) {
  const occurrence = (slugSeen.get(record.slug) || 0) + 1;
  slugSeen.set(record.slug, occurrence);
  const augmentId = slugCounts.get(record.slug) > 1 && occurrence < slugCounts.get(record.slug)
    ? `${record.slug}-${record.id}`
    : record.slug;
  augmentFileById.set(record.id, `${augmentId}.md`);
  await writeFile(
    resolve(SEED, "augments", `${augmentId}.md`),
    augmentDoc(record, augments, augmentId, augmentDetailById.get(record.id) ?? null, heroSlugSet),
    "utf8",
  );
}

// Enrich champion aliases with detail-page nicknames, skipping aliases already claimed
// by another champion to keep retrieval unambiguous.
const claimed = new Set();
for (const record of heroes.records) {
  const { title, aliases } = championNames(record.name, record.slug);
  for (const alias of [title, ...aliases]) claimed.add(alias);
}
const otherNamesBySlug = new Map();
if (heroesDetail) {
  for (const record of heroes.records) {
    const detail = heroDetailById.get(record.id);
    const names = (detail?.otherNames ?? []).filter((name) => name && !claimed.has(name));
    for (const name of names) claimed.add(name);
    otherNamesBySlug.set(record.slug, names);
  }
}

for (const record of heroes.records) {
  await writeFile(
    resolve(SEED, "champions", `${record.slug}.md`),
    championDoc(record, heroes, heroDetailById.get(record.id) ?? null, augmentFileById, otherNamesBySlug.get(record.slug) ?? []),
    "utf8",
  );
}

const registry = {
  scope: `Hexdata public hero index, Patch ${heroes.patch}; aggregate statistics remain draft and unverified.`,
  source: heroes.sourceUrl,
  report_date: heroes.reportDate,
  champions: heroes.records.map((record) => {
    const { title, aliases } = championNames(record.name, record.slug);
    const merged = [...new Set([...aliases, ...(otherNamesBySlug.get(record.slug) ?? [])])];
    return { id: record.slug, name: title, aliases: merged, game_id: String(record.id) };
  }),
};
await writeFile(resolve(SEED, "champion-registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const paths = [];
for (const directory of ["champions", "augments"]) {
  for (const file of (await readdir(resolve(SEED, directory))).filter((name) => name.endsWith(".md")).sort()) {
    paths.push(`${directory}/${file}`);
  }
}
const compatibilityOrder = ["champions/ahri.md", "champions/garen.md", "augments/custom-example.md"];
const orderedPaths = [...compatibilityOrder, ...paths.filter((path) => !compatibilityOrder.includes(path))];
const entries = orderedPaths.map((path) => {
  const previous = previousHashes.get(path);
  const hashLiteral = previous === undefined ? "0" : `0x${previous.toString(16).padStart(16, "0")}`;
  return `    ("${path}", include_str!("../../knowledge-seed/${path}"), ${hashLiteral}),`;
});
await writeFile(
  CATALOG,
  `// Generated by scripts/import-hexdata-knowledge.mjs. Do not edit by hand.\n` +
    `// Third field: FNV-1a 64 of the previous seed generation's content, or 0 when the\n` +
    `// file is new. The v3 migration refreshes a document only when its content still\n` +
    `// hashes to this value; user edits never match and are never overwritten.\n` +
    `pub const SEEDS: &[(&str, &str, u64)] = &[\n${entries.join("\n")}\n];\n`,
  "utf8",
);

console.log(`champions: ${heroes.records.length} (detail: ${heroDetailById.size})`);
console.log(`augments: ${augments.records.length} (detail: ${augmentDetailById.size})`);
console.log(`catalog entries: ${entries.length}`);
