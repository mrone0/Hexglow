#!/usr/bin/env node
// 由 src-tauri/data/augments.json 生成 knowledge-seed/augments/*.md（OKF 0.2 海克斯种子）。
// 只做文本切分与事实罗列，不编造数值；全部标记 verified:false / status:draft。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'src-tauri/data/augments.json');
const outDir = path.join(root, 'knowledge-seed/augments');

const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const rows = data.augments;

const yamlStr = (value) =>
  `"${String(value).replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const unique = (list) => [...new Set(list.filter((item) => item && item.trim()))];
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

const renderDoc = (row) => {
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
    `  patch: ${yamlStr(data.meta.patch)}`,
    `  augment_id: ${yamlStr(String(row.id))}`,
    `  game_id: ${row.id}`,
    `  aliases: [${aliases.map(yamlStr).join(', ')}]`,
    `  name_en: ${yamlStr(row.nameEn || row.nameId || row.name)}`,
    `  rarity: ${yamlStr(row.rarity)}`,
    `  category: ${yamlStr(row.category)}`,
    `  effect_source: ${yamlStr(row.effectSource || 'aramgg.com')}`,
    `  sources: [${(row.sources || []).map(yamlStr).join(', ')}]`,
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
    '> `verified: false` · `status: draft`。效果文本抓取自第三方站点，未经游戏内核验，以游戏内描述为准。禁用胜率类字段。',
    '',
    '## 完整效果',
    '',
    effect || '（缺失）',
    '',
    `来源：${row.effectSource || 'aramgg.com'}（第三方，未校验）。`,
    alt ? `另一来源（${row.effectSource === 'hexdata.com.cn' ? 'aramgg.com' : 'hexdata.com.cn'}）文本：${alt}` : '',
    alt ? '两源文本不一致，以游戏内描述为准。' : '',
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
    `- 来源：${(row.sources || []).join(' + ')}；冲突字段：${(row.conflicts || []).join('、') || '无'}。`,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return `${frontmatter.join('\n')}\n${body}`;
};

fs.mkdirSync(outDir, {recursive: true});
let written = 0;
for (const row of rows) {
  const file = path.join(outDir, `${row.id}.md`);
  fs.writeFileSync(file, renderDoc(row), 'utf8');
  written += 1;
}

// 生成 Rust 种子模块，供 src-tauri 做 v2 增量播种（只新增缺失文件）。
const seedModule = [
  '//! 由 scripts/build-knowledge.mjs 生成，勿手改：knowledge-seed/augments/*.md 的内嵌副本。',
  '//! 用于 v2 增量播种，只新增缺失文件，不覆盖用户编辑。',
  '#[rustfmt::skip]',
  'pub static AUGMENT_SEEDS: &[(&str, &str)] = &[',
  ...rows.map((row) => `    ("augments/${row.id}.md", include_str!("../../knowledge-seed/augments/${row.id}.md")),`),
  '];',
  '',
].join('\n');
fs.writeFileSync(path.join(root, 'src-tauri/src/seed_augments.rs'), seedModule, 'utf8');

const meta = {
  generator: 'scripts/build-knowledge.mjs',
  input: 'src-tauri/data/augments.json',
  patch: data.meta.patch,
  generatedAt: new Date().toISOString(),
  count: written,
  note: '仅新增/覆盖由本脚本生成的 <id>.md，不触碰 custom-example.md 或 champions/。',
};
fs.writeFileSync(path.join(outDir, 'generated.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`已生成 ${written} 份海克斯 OKF 种子 → knowledge-seed/augments/ 与 src-tauri/src/seed_augments.rs`);
