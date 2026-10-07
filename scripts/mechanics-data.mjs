import fs from 'node:fs';

// 固定版本的官方资料和人工审核 trait；重新抓基础名单时不能静默丢失。
const curated = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/champion-mechanics.json', import.meta.url), 'utf8'));

export function withChampionMechanics(champion, patch, catalog = curated) {
  const details = catalog.champions[champion.id];
  if (!details) return champion;
  const copy = structuredClone(details);
  if (copy.abilityPatch !== patch) {
    copy.mechanics.traits = [];
    copy.mechanics.reviewStatus = 'stale';
    copy.mechanics.limitations = [
      ...copy.mechanics.limitations,
      `机制资料审核版本为 ${copy.abilityPatch}，当前基础数据为 ${patch}；技能描述保留原始来源，评分 trait 已停用，等待重新核实。`,
    ];
  }
  return {...champion, ...copy};
}
