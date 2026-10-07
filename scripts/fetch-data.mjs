// Run with node (pnpm data:fetch).
/**
 * 抓取英雄基础属性与海克斯数据，生成 src-tauri/data/*.json。
 *
 *   pnpm data:fetch            使用 .data-cache 缓存（增量、快）
 *   pnpm data:fetch --refresh  忽略缓存重新抓取
 *
 * 数据来源（每条产物记录 source，全部标记 verified:false）：
 *   1. Data Dragon cdn  —— 英雄基础属性（Riot 官方 CDN）
 *   2. CommunityDragon   —— 海克斯 id / 中英名称 / 稀有度（Riot 客户端数据）
 *   3. aramgg.com        —— 海克斯效果文本（主源，第三方）
 *   4. hexdata.com.cn    —— 效果文本交叉校验（第三方）
 *
 * 刻意不抓取也不写入：胜率、选取率、T 层级、HexScore。
 * Riot 开发者政策禁止展示海克斯胜率聚合数据。
 */
import {deriveTags} from './data-tags.mjs';
import {withChampionMechanics} from './mechanics-data.mjs';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'data');
const CACHE_DIR = path.join(ROOT, '.data-cache');
const REFRESH = process.argv.includes('--refresh');

const USER_AGENT = 'HexglowDataFetcher/1.0 (+local research; contact via repository)';

const RARITY_MAP = {kSilver: 'silver', kGold: 'gold', kPrismatic: 'prismatic', kEventChoice: 'event'};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, {retries = 5} = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate'},
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1);
        // 服务端可能要求等待数小时（整站限流）。超过 60 秒就不再空转，交由调用方记录为覆盖缺口。
        const retryable = wait <= 60000;
        throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), {retryable, wait});
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      const isHttp = String(error.message).startsWith('HTTP ');
      if (isHttp && !error.retryable) throw error;
      if (attempt === retries - 1) break;
      const wait = error.retryable && error.wait ? error.wait : 400 * (attempt + 1);
      await sleep(wait);
    }
  }
  throw lastError;
}

async function cached(url, {onMiss} = {}) {
  const key = createHash('sha1').update(url).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.html`);
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (onMiss) await onMiss();
  const text = await fetchText(url);
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.writeFileSync(file, text);
  return text;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

const decodeEntities = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');

const stripTags = (html) => decodeEntities(html.replace(/<[^>]+>/g, ''));

/** Riot 的界面标记（%i:Augment% 等）在数据文本里没有意义，去掉。 */
const cleanEffect = (text) =>
  decodeEntities(text)
    .replace(/%[A-Za-z][A-Za-z0-9:]*%/g, '')
    .replace(/\{\{[^}]*\}\}/g, (m) => m.slice(2, -2))
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const comparable = (text) =>
  (text || '')
    .replace(/任务[:：]|需求[:：]|奖励[:：]/g, '')
    .replace(/[\s　【】\[\]()（）:：。.、，,；;！!？?“”"'’‘·\-—_/\\|]+/g, '');

// ---------------------------------------------------------------- 英雄基础属性

export async function fetchChampions(loadText = cached) {
  const versions = JSON.parse(await loadText('https://ddragon.leagueoflegends.com/api/versions.json'));
  const patch = versions[0];
  const load = async (locale) =>
    JSON.parse(await loadText(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/${locale}/champion.json`));
  const zh = await load('zh_CN');
  const en = await load('en_US');
  const champions = Object.values(en.data).map((champ) => {
    const local = zh.data[champ.id] || {};
    return withChampionMechanics({
      key: champ.key,
      id: champ.id,
      name: champ.name,
      title: champ.title,
      nameZh: local.name || '',
      titleZh: local.title || '',
      aliases: [...new Set([local.title, local.name, champ.name, champ.title].filter(Boolean))],
      tags: champ.tags,
      partype: local.partype || champ.partype,
      info: champ.info,
      stats: champ.stats,
    }, patch);
  });
  champions.sort((a, b) => a.name.localeCompare(b.name));
  return {
    meta: {
      patch,
      source: 'ddragon.leagueoflegends.com',
      locales: ['zh_CN', 'en_US'],
      fetchedAt: new Date().toISOString(),
      count: champions.length,
      fields: {
        name: '英文英雄名（与 Live API championName 一致）',
        title: '英文称号',
        nameZh: '中文称号（如：九尾妖狐）',
        titleZh: '中文常用名（如：阿狸）',
      },
      note: '基础属性与成长值来自 Data Dragon 官方 CDN；未包含大乱斗模式系数。',
    },
    champions,
  };
}

// ---------------------------------------------------------------- 海克斯基础表

async function fetchAugmentRegistry() {
  const parse = async (locale) =>
    JSON.parse(
      await cached(
        `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/${locale}/v1/cherry-augments.json`,
      ),
    );
  const zh = await parse('zh_cn');
  const en = await parse('default');
  const byId = new Map();
  for (const row of zh) {
    byId.set(row.id, {
      id: row.id,
      nameId: row.augmentNameId,
      name: row.nameTRA,
      rarity: RARITY_MAP[row.rarity] || null,
      iconPath: row.augmentSmallIconPath || null,
    });
  }
  for (const row of en) {
    const target = byId.get(row.id);
    if (target) target.nameEn = row.nameTRA;
  }
  return byId;
}

// ---------------------------------------------------------------- aramgg 主源

async function fetchAramggIndex() {
  const html = await cached('https://aramgg.com/zh-CN/augments');
  const ids = [...new Set([...html.matchAll(/href="\/zh-CN\/augments\/(\d+)"/g)].map((m) => Number(m[1])))];
  return ids.sort((a, b) => a - b);
}

function parseAramgg(html) {
  const name = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() || null;
  const rarityClass = html.match(/class="augment-icon[^"]*\brarity-(silver|gold|prismatic)\b/)?.[1] || null;
  const effectHtml = html.match(
    /<p class="text-sm leading-relaxed text-muted-foreground">([\s\S]*?)<\/p>/,
  )?.[1];
  const badge = html.match(/border px-2 py-0\.5 text-xs[^>]*>([^<]+)</)?.[1]?.trim() || null;
  const badgeRarity = ['白银', '黄金', '棱彩'].includes(badge)
    ? {白银: 'silver', gold: 'gold', 黄金: 'gold', 棱彩: 'prismatic'}[badge]
    : null;
  return {
    name,
    rarity: rarityClass || badgeRarity || null,
    effect: effectHtml ? cleanEffect(stripTags(effectHtml)) : null,
  };
}

async function fetchAramggDetails(ids) {
  const rows = await mapLimit(ids, 4, async (id) => {
    try {
      const html = await cached(`https://aramgg.com/zh-CN/augments/${id}`, {onMiss: () => sleep(150)});
      return {id, ...parseAramgg(html)};
    } catch (error) {
      console.warn(`      aramgg ${id} 失败：${error.message}`);
      return null;
    }
  });
  return new Map(rows.filter(Boolean).map((row) => [row.id, row]));
}

// ---------------------------------------------------------------- hexdata 校验源

async function fetchHexdataUrls() {
  const xml = await cached('https://hexdata.com.cn/sitemap.xml');
  const urls = [...xml.matchAll(/<loc>(https:\/\/hexdata\.com\.cn\/augment\/\d+-[^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls.sort();
}

function parseHexdata(html) {
  const raw = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() || null;
  const name = raw ? raw.replace(/海克斯胜率与适配英雄.*$/, '').trim() || null : null;
  const rarityZh = html.match(/是(白银|黄金|棱彩)海克斯/)?.[1] || null;
  const rarity = {白银: 'silver', 黄金: 'gold', 棱彩: 'prismatic'}[rarityZh] || null;
  const guide = html.match(
    /高分高样本英雄上考虑。([\s\S]*?)如果你的英雄机制能稳定触发这个海克斯/,
  )?.[1];
  return {name, rarity, effect: guide ? cleanEffect(stripTags(guide)) : null};
}

async function fetchHexdataDetails(urls) {
  const rows = await mapLimit(urls, 1, async (url) => {
    const id = Number(url.match(/augment\/(\d+)-/)?.[1]);
    try {
      const html = await cached(url, {onMiss: () => sleep(800)});
      return {id, url, ...parseHexdata(html)};
    } catch (error) {
      console.warn(`      hexdata ${id} 失败：${error.message}`);
      return null;
    }
  });
  return new Map(rows.filter(Boolean).map((row) => [row.id, row]));
}

// ---------------------------------------------------------------- 标签推导

// ---------------------------------------------------------------- 合并

function merge({registry, pool, aramgg, hexdata}) {
  const augments = [];
  const missing = [];
  const checkMissing = [];
  for (const id of [...pool].sort((a, b) => a - b)) {
    const base = registry.get(id);
    if (!base) {
      missing.push(id);
      continue;
    }
    const primary = aramgg.get(id) || null;
    const check = hexdata.get(id) || null;
    if (!primary && !check) {
      missing.push(id);
      continue;
    }
    const conflicts = [];
    // aramgg 的文案常带 Riot 动态占位符（?），hexdata 有时给出实际数值；优先选没有占位符的版本。
    const primaryHasPlaceholder = primary?.effect ? /\?/.test(primary.effect) : false;
    const checkHasPlaceholder = check?.effect ? /\?/.test(check.effect) : false;
    let effect = primary?.effect || check?.effect || '';
    let effectSource = primary?.effect ? 'aramgg.com' : check?.effect ? 'hexdata.com.cn' : null;
    if (primary?.effect && check?.effect && primaryHasPlaceholder && !checkHasPlaceholder) {
      effect = check.effect;
      effectSource = 'hexdata.com.cn';
    }
    if (!primary) conflicts.push('missing-primary');
    if (primary?.rarity && base.rarity && primary.rarity !== base.rarity) {
      conflicts.push('rarity:primary');
    }
    if (check?.rarity && base.rarity && check.rarity !== base.rarity) {
      conflicts.push('rarity:check');
    }
    const otherEffect = effectSource === 'aramgg.com' ? check?.effect : primary?.effect;
    if (effect && otherEffect && comparable(effect) !== comparable(otherEffect)) {
      conflicts.push('effect');
    }
    if (!check) checkMissing.push(id);
    const {category, tags} = deriveTags(effect);
    const aliases = [...new Set([primary?.name, check?.name].filter((n) => n && n !== base.name))];
    augments.push({
      id,
      nameId: base.nameId,
      name: base.name,
      nameEn: base.nameEn || '',
      aliases,
      rarity: base.rarity,
      effect,
      category,
      tags,
      iconPath: base.iconPath,
      verified: false,
      effectSource,
      sources: ['communitydragon', ...(primary ? ['aramgg.com'] : []), ...(check ? ['hexdata.com.cn'] : [])],
      ...(conflicts.length
        ? {conflicts, effectAlt: conflicts.includes('effect') ? otherEffect : undefined}
        : {}),
    });
  }
  return {augments, missing, checkMissing};
}

function assertHealthy({augments, missing, checkMissing}) {
  const problems = [];
  const warnings = [];
  if (missing.length) problems.push(`${missing.length} 个海克斯缺少效果文本：${missing.join(', ')}`);
  const noName = augments.filter((row) => !row.name).map((row) => row.id);
  if (noName.length) problems.push(`缺少名称：${noName.join(', ')}`);
  const noRarity = augments.filter((row) => !row.rarity).map((row) => row.id);
  if (noRarity.length) problems.push(`缺少稀有度：${noRarity.join(', ')}`);
  const noEffect = augments.filter((row) => !row.effect).map((row) => row.id);
  if (noEffect.length) problems.push(`缺少效果：${noEffect.join(', ')}`);
  const conflicts = augments.filter((row) => row.conflicts?.length);
  if (conflicts.length) {
    warnings.push(
      `${conflicts.length} 条两源效果文本不一致（已保留 effectAlt 供人工核对）：${conflicts
        .map((row) => row.id)
        .join(', ')}`,
    );
  }
  if (checkMissing.length) {
    warnings.push(`${checkMissing.length} 条没有交叉校验源（hexdata 限流），仅单源效果文本：${checkMissing.join(', ')}`);
  }
  return {problems, warnings};
}

function writeJson(file, data) {
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const target = path.join(OUT_DIR, file);
  fs.writeFileSync(target, `${JSON.stringify(data, null, 1)}\n`);
  return target;
}

async function main() {
  const started = Date.now();
  console.log('[1/5] 英雄基础属性（Data Dragon）…');
  const champions = await fetchChampions();
  console.log(`      ${champions.champions.length} 位英雄 · patch ${champions.meta.patch}`);

  console.log('[2/5] 海克斯基础表（CommunityDragon）…');
  const registry = await fetchAugmentRegistry();
  console.log(`      ${registry.size} 条客户端记录`);

  console.log('[3/5] aramgg.com 效果文本（主源）…');
  const ids = await fetchAramggIndex();
  console.log(`      索引 ${ids.length} 条，开始抓取详情…`);
  const aramgg = await fetchAramggDetails(ids);
  console.log(`      完成 ${aramgg.size}/${ids.length}`);

  console.log('[4/5] hexdata.com.cn 交叉校验…');
  const urls = await fetchHexdataUrls();
  const hexdata = await fetchHexdataDetails(urls);
  console.log(`      完成 ${hexdata.size}/${urls.length}`);

  console.log('[5/5] 合并与校验…');
  const merged = merge({registry, pool: ids, aramgg, hexdata});
  const {problems, warnings} = assertHealthy(merged);
  const conflictCount = merged.augments.filter((row) => row.conflicts?.length).length;

  const championFile = writeJson('champions.json', champions);
  const augmentFile = writeJson('augments.json', {
    meta: {
      patch: champions.meta.patch,
      fetchedAt: new Date().toISOString(),
      pool: 'ARAM Mayhem（海克斯大乱斗）',
      count: merged.augments.length,
      rarityOrder: ['silver', 'gold', 'prismatic'],
      sources: {
        registry: 'communitydragon.org（id / 中英文名称 / 稀有度 / 图标路径）',
        effect: 'aramgg.com（主源，第三方，未校验）',
        verify: 'hexdata.com.cn（交叉校验，第三方，未校验）',
      },
      excluded: ['winRate', 'pickRate', 'tier', 'hexScore'],
      note: '全部条目 verified:false；效果文本未经游戏内核验，以游戏内描述为准。禁用胜率类字段（Riot 开发者政策）。',
      conflicts: conflictCount,
      verifiedBySecondSource: merged.augments.length - merged.checkMissing.length,
      withoutSecondSource: merged.checkMissing,
    },
    augments: merged.augments,
  });

  console.log('');
  console.log(`英雄  ${championFile}`);
  console.log(`海克斯 ${augmentFile}`);
  console.log(`共 ${merged.augments.length} 条海克斯 · ${conflictCount} 条来源分歧 · 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (warnings.length) {
    console.log('');
    console.log('需要人工确认（不阻断）：');
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  if (problems.length) {
    console.log('');
    console.log('数据缺失（阻断）：');
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
