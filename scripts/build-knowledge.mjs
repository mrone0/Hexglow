#!/usr/bin/env node
// 由 src-tauri/data/*.json 生成 OKF 种子：
//   knowledge-seed/augments/<id>.md    海克斯 211 份
//   knowledge-seed/champions/<id>.md   英雄 171 份（ahri/garen 为人工种子，跳过）
//   knowledge-seed/champion-registry.json 英雄名单（供校验与检索）
//   src-tauri/src/seed_generated.rs    Rust 内嵌副本，供增量播种
// 只罗列打包数据里的事实，不编造数值；全部 status:draft / verified:false；不含胜率类字段。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const augmentInput = path.join(root, 'src-tauri/data/augments.json');
const championInput = path.join(root, 'src-tauri/data/champions.json');
const augmentDir = path.join(root, 'knowledge-seed/augments');
const championDir = path.join(root, 'knowledge-seed/champions');

const augments = JSON.parse(fs.readFileSync(augmentInput, 'utf8'));
const championData = JSON.parse(fs.readFileSync(championInput, 'utf8'));
const rows = augments.augments;
const champions = championData.champions;
const patch = augments.meta?.patch || championData.meta?.patch || 'unknown';

// 人工维护的英雄种子：由 knowledge.rs 内嵌，不由本脚本生成或覆盖。
const CURATED_CHAMPIONS = new Set(['ahri', 'garen']);

const yamlStr = (value) =>
  `"${String(value).replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const unique = (list) => [...new Set(list.filter((item) => item && String(item).trim()))];
const sentences = (text) =>
  (text || '')
    .split(/(?<=。)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

const TRIGGER = /当.{0,24}时|之后|后|每当|下一次|下次|命中|施放|释放|使用|击杀|购买|达成|达到|持续|期间|在.{0,16}(内|中)|层数|仅在/;
const LIMIT = /仅|只|不能|不会|无法|最多|至多|上限|唯一|除外|失效|不再|不享受|不计入|若.{0,12}(不|无|未)/;
const ENTITY = /【([^】]+)】/g;

const tagCount = new Map();
for (const row of rows) for (const tag of row.tags || []) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
const namesByTag = new Map();
for (const row of rows) {
  for (const tag of row.tags || []) {
    if (!namesByTag.has(tag)) namesByTag.set(tag, []);
    namesByTag.get(tag).push(row.name);
  }
}
for (const names of namesByTag.values()) names.sort();

// 由源标签推导的本地元数据（启发式，非官方字段）：仅供排序与检索，不改变效果文本。
const ROLE_BY_TAG = {
  crit: 'Marksman', as: 'Marksman', onhit: 'Marksman', range: 'Marksman',
  ap: 'Mage', mana: 'Mage',
  tank: 'Tank', hp: 'Tank',
  cc: 'Support', summoner: 'Support',
  mobility: 'Assassin', ultimate: 'Assassin',
  ad: 'Fighter', sustain: 'Fighter',
  haste: 'Flexible', stack: 'Flexible', economy: 'Flexible',
};
const SCALING_TAGS = ['hp', 'ap', 'ad', 'as', 'crit', 'mana'];
const RARITY_WEIGHT = {prismatic: 3, gold: 2, silver: 1};

const roleFit = (tags) => {
  const roles = unique(tags.map((tag) => ROLE_BY_TAG[tag]).filter(Boolean));
  return roles.length ? roles.slice(0, 4) : ['Flexible'];
};
const scalingOf = (tags) =>
  tags.includes('stack') ? 'stacking' : tags.some((tag) => SCALING_TAGS.includes(tag)) ? 'stat-scaling' : 'flat';

const pickClauses = (texts, pattern) => {
  const hits = [];
  for (const text of texts) for (const sentence of sentences(text)) {
    if (pattern.test(sentence) && !hits.includes(sentence)) hits.push(sentence);
  }
  return hits;
};

const renderAugment = (row) => {
  const effect = row.effect || '';
  const alt = row.effectAlt || '';
  const aliases = unique([row.nameEn, ...(row.aliases || [])].filter((name) => name !== row.name));
  const related = unique((row.tags || []).flatMap((tag) => namesByTag.get(tag) || []))
    .filter((name) => name !== row.name)
    .slice(0, 6);

  const frontmatter = [
    '---',
    `title: ${yamlStr(row.name)}`,
    `description: ${yamlStr(effect.slice(0, 140))}`,
    `tags: [${unique(['augment', ...(row.tags || [])]).map(yamlStr).join(', ')}]`,
    'status: draft',
    'type: Augment',
    'hexglow:',
    '  schema_version: 1',
    '  mode: hextech-aram',
    `  patch: ${yamlStr(patch)}`,
    `  augment_id: ${yamlStr(String(row.id))}`,
    `  game_id: ${row.id}`,
    `  aliases: [${aliases.map(yamlStr).join(', ')}]`,
    `  name_en: ${yamlStr(row.nameEn || row.nameId || row.name)}`,
    `  rarity: ${yamlStr(row.rarity)}`,
    `  category: ${yamlStr(row.category)}`,
    `  tags: [${(row.tags || []).map(yamlStr).join(', ')}]`,
    `  synergy_tags: [${(row.tags || []).map(yamlStr).join(', ')}]`,
    `  role_fit: [${roleFit(row.tags || []).map(yamlStr).join(', ')}]`,
    `  scaling: ${yamlStr(scalingOf(row.tags || []))}`,
    '  verified: false',
    '---',
  ];

  const triggers = pickClauses([effect], TRIGGER);
  const limits = pickClauses([effect], LIMIT);
  const entitiesFromText = unique([...effect.matchAll(ENTITY)].map((m) => m[1]));

  const body = [
    `# ${row.name}`,
    '',
    '> `verified: false` · `status: draft`。效果文本未经游戏内核验，以游戏内描述为准。禁用胜率类字段。',
    '',
    '## 完整效果',
    '',
    effect || '（缺失）',
    '',
    alt ? `另一版本文本（未核验）：${alt}` : '',
    alt && alt !== effect ? '两种文本不一致，以游戏内描述为准。' : '',
    '',
    '## 触发条件',
    '',
    triggers.length
      ? triggers.map((clause) => `- ${clause}`).join('\n')
      : '- 效果文本中未出现单独触发条件，按常驻效果处理（由文本切分，未经人工核验）。',
    '',
    '## 限制与例外',
    '',
    limits.length
      ? limits.map((clause) => `- ${clause}`).join('\n')
      : '- 效果文本中未发现明确限制；以游戏内描述为准（未经人工核验）。',
    '',
    '## 相关交互',
    '',
    `- 标签：${(row.tags || []).join('、') || '（无）'}；类别：${row.category}；稀有度：${row.rarity}。`,
    entitiesFromText.length
      ? `- 文本提到的实体：${entitiesFromText.slice(0, 8).map((name) => `【${name}】`).join('、')}`
      : '- 文本未提到其他【实体】。',
    related.length ? `- 共享标签的其他海克斯（节选）：${related.slice(0, 6).join('、')}` : '',
    `- 冲突字段：${(row.conflicts || []).join('、') || '无'}。`,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return `${frontmatter.join('\n')}\n${body}`;
};

// 英雄：只写打包数据里的属性事实 + 由标签推导的定位，不编造技能机制与打法细节。
const renderChampion = (row) => {
  const stem = row.id.toLowerCase();
  const stats = row.stats || {};
  const info = row.info || {};
  const roles = row.tags || [];
  const ranged = (stats.attackrange ?? 0) >= 500;
  const damage =
    (info.attack ?? 0) >= (info.magic ?? 0) + 2 ? '物理' : (info.magic ?? 0) >= (info.attack ?? 0) + 2 ? '法术' : '混合';
  const display = row.nameZh ? `${row.nameZh}${row.titleZh ? ` · ${row.titleZh}` : ''}` : row.name;
  const aliases = unique([row.id, row.name, row.title, row.nameZh, row.titleZh]).filter(
    (alias) => alias !== display && alias !== row.nameZh,
  );
  const fitted = rows
    .filter((augment) => roleFit(augment.tags || []).some((role) => roles.includes(role)))
    .sort(
      (a, b) =>
        (RARITY_WEIGHT[b.rarity] || 0) - (RARITY_WEIGHT[a.rarity] || 0) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN'),
    )
    .slice(0, 8);

  const frontmatter = [
    '---',
    `title: ${yamlStr(display)}`,
    `description: ${yamlStr(`${roles.join('、') || '未分类'} · ${ranged ? '远程' : '近战'} · 打包数据推导，未核验`)}`,
    `tags: [${unique(['champion', ...roles]).map(yamlStr).join(', ')}]`,
    'status: draft',
    'type: Champion',
    'hexglow:',
    '  schema_version: 1',
    '  mode: hextech-aram',
    `  patch: ${yamlStr(patch)}`,
    `  champion_id: ${yamlStr(stem)}`,
    `  game_id: ${yamlStr(String(row.key ?? stem))}`,
    `  aliases: [${aliases.map(yamlStr).join(', ')}]`,
    `  role_fit: [${roles.map(yamlStr).join(', ')}]`,
    '  verified: false',
    '---',
  ];

  const body = [
    `# ${display}`,
    '',
    '> `verified: false` · `status: draft`。以下全部来自打包数据，未人工核验；不含胜率、选取率与强度分级。',
    '',
    '## 基础机制',
    '',
    `- 定位标签：${roles.join('、') || '（数据未提供）'}；${ranged ? '远程' : '近战'}（攻击距离 ${stats.attackrange ?? '未知'}）。`,
    `- 属性评分：攻击 ${info.attack ?? '?'} · 防御 ${info.defense ?? '?'} · 法术 ${info.magic ?? '?'} · 难度 ${info.difficulty ?? '?'}（1-10 客户端评分）。`,
    `- 生命 ${stats.hp ?? '?'}（每级 +${stats.hpperlevel ?? '?'}）· 护甲 ${stats.armor ?? '?'} · 魔抗 ${stats.spellblock ?? '?'} · 移速 ${stats.movespeed ?? '?'}。`,
    `- 攻击力 ${stats.attackdamage ?? '?'} · 攻速 ${stats.attackspeed ?? '?'} · 资源类型：${row.partype || '未知'}。`,
    `- 伤害倾向：${damage}（由属性评分推导，非官方分类）。`,
    '',
    '## 常见打法',
    '',
    `- 由标签推导（未核验）：${roles.join('、') || '未分类'}定位，只说明角色分类，不含技能连招与出装顺序。`,
    `- ${ranged ? '远程：可依托攻击距离保持输出空间' : '近战：需要接近目标才能普攻'}（由攻击距离 ${stats.attackrange ?? '?'} 推导）。`,
    '- 具体打法、符文与出装未收录，以游戏内实际情况为准。',
    '',
    '## 海克斯搭配',
    '',
    fitted.length
      ? `- 按标签匹配的候选（启发式、未核验）：${fitted.map((augment) => augment.name).join('、')}`
      : '- 打包数据中没有与该标签匹配的海克斯候选。',
    '- 完整效果与限制见 `augments/` 目录下的对应文件；排序依据是本地规则，不是胜率。',
    '',
    '## 注意事项',
    '',
    '- 本文件由脚本按打包数据生成，未经人工核验，不要当作官方机制说明。',
    '- 不包含胜率、选取率、强度分级；缺失项一律标为未知，不推断。',
    '',
  ].join('\n');

  return `${frontmatter.join('\n')}\n${body}`;
};

fs.mkdirSync(augmentDir, {recursive: true});
fs.mkdirSync(championDir, {recursive: true});

let augmentCount = 0;
for (const row of rows) {
  fs.writeFileSync(path.join(augmentDir, `${row.id}.md`), renderAugment(row), 'utf8');
  augmentCount += 1;
}

let championCount = 0;
const generatedChampions = [];
for (const row of champions) {
  const stem = row.id.toLowerCase();
  if (CURATED_CHAMPIONS.has(stem)) continue;
  fs.writeFileSync(path.join(championDir, `${stem}.md`), renderChampion(row), 'utf8');
  championCount += 1;
  generatedChampions.push(row);
}

const registry = {
  scope: `Generated from src-tauri/data/champions.json (patch ${patch}); full roster of ${champions.length} champions, attributes only, no mechanics.`,
  champions: champions.map((row) => ({
    id: row.id.toLowerCase(),
    name: row.nameZh || row.name,
    aliases: unique([row.id, row.name, row.title, row.nameZh, row.titleZh].filter((alias) => alias !== (row.nameZh || row.name))),
    game_id: String(row.key ?? row.id),
  })),
};
fs.writeFileSync(
  path.join(root, 'knowledge-seed/champion-registry.json'),
  `${JSON.stringify(registry, null, 2)}\n`,
  'utf8',
);

// 生成 Rust 种子模块：只补缺失文件，不覆盖用户编辑（见 knowledge.rs 的增量播种）。
const quote = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const seedEntries = (dir, items, idOf) =>
  items.map((row) => `    ("${dir}/${quote(idOf(row))}.md", include_str!("../../knowledge-seed/${dir}/${quote(idOf(row))}.md")),`);

const seedModule = [
  '//! 由 scripts/build-knowledge.mjs 生成，勿手改：knowledge-seed 生成件的内嵌副本。',
  '//! 用于增量播种，只新增缺失文件，不覆盖用户编辑。',
  '#[rustfmt::skip]',
  `pub static AUGMENT_SEEDS: &[(&str, &str)] = &[`,
  ...seedEntries('augments', rows, (row) => String(row.id)),
  '];',
  '',
  '#[rustfmt::skip]',
  `pub static CHAMPION_SEEDS: &[(&str, &str)] = &[`,
  ...seedEntries('champions', generatedChampions, (row) => row.id.toLowerCase()),
  '];',
  '',
].join('\n');
fs.writeFileSync(path.join(root, 'src-tauri/src/seed_generated.rs'), seedModule, 'utf8');
const staleSeedModule = path.join(root, 'src-tauri/src/seed_augments.rs');
if (fs.existsSync(staleSeedModule)) fs.unlinkSync(staleSeedModule);

const meta = {
  generator: 'scripts/build-knowledge.mjs',
  input: ['src-tauri/data/augments.json', 'src-tauri/data/champions.json'],
  patch,
  generatedAt: new Date().toISOString(),
  augments: augmentCount,
  champions: championCount,
  registry: champions.length,
  note: '只生成 <id>.md；不触碰 custom-example.md、champions/ahri.md、champions/garen.md。',
};
fs.writeFileSync(path.join(augmentDir, 'generated.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(
  `已生成 ${augmentCount} 份海克斯、${championCount} 份英雄 OKF 种子（registry ${champions.length}） → src-tauri/src/seed_generated.rs`,
);
