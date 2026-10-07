import {test} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deriveTags} from './data-tags.mjs';

test('penetration is offensive and does not grant a tank tag', () => {
  assert.deepEqual(deriveTags('获得18%护甲穿透和法术穿透。'), {category:'damage', tags:['ad','ap']});
  assert.equal(deriveTags('获得25护甲和25魔法抗性。').category, 'defense');
  assert.ok(deriveTags('获得25护甲和25魔法抗性。').tags.includes('tank'));
});

test('costs, damage triggers and lost attributes do not become positive affinity', () => {
  const cases = [
    ['获得1500生命值，但你造成的伤害降低10%。', {category:'defense', tags:['hp']}],
    ['获得100%移动速度，在受到伤害后失效6秒。', {category:'utility', tags:['mobility']}],
    ['在对敌方英雄造成伤害后提供生命和法力回复。', {category:'defense', tags:['sustain','mana']}],
    ['减少30%最大生命值。造成额外真实伤害。', {category:'damage', tags:[]}],
    ['将额外攻击力转化为法术强度。获得15%法术强度。', {category:'damage', tags:['ap']}],
    ['将法术强度转化为额外攻击力。获得15%攻击力。', {category:'damage', tags:['ad']}],
    ['获得冷却缩减并将你的所有攻击速度转化为技能急速。', {category:'utility', tags:['haste']}],
  ];
  for (const [effect, expected] of cases) assert.deepEqual(deriveTags(effect), expected, effect);
  assert.equal(deriveTags('在对敌方英雄造成伤害后，再造成额外伤害。').category, 'damage');
});

test('ultimate restrictions and defensive control mentions are not offensive capability', () => {
  assert.deepEqual(deriveTags('获得技能急速，但你不能使用你的终极技能。'), {category:'utility', tags:['haste']});
  assert.deepEqual(deriveTags('用一个非终极技能命中敌人时，返还该技能冷却时间。'), {category:'utility', tags:['haste']});
  assert.deepEqual(deriveTags('获得50移动速度和40%减速抗性。'), {category:'utility', tags:['mobility']});
  assert.deepEqual(deriveTags('你的减速效果可使移动速度降低额外的75。'), {category:'utility', tags:['cc']});
  assert.deepEqual(deriveTags('你的终极技能使你进入免疫伤害状态。'), {category:'defense', tags:['tank','ultimate']});
});

test('enemy attributes and attack-related wording do not imply owned stats', () => {
  assert.deepEqual(deriveTags('在朝着低生命值的敌人时，获得额外移动速度。'), {category:'utility', tags:['mobility']});
  assert.deepEqual(deriveTags('获得额外攻击距离和额外攻击速度。'), {category:'damage', tags:['as','range']});
  const shred = deriveTags('造成伤害时，对敌人施加护甲和魔法抗性击碎效果。');
  assert.equal(shred.category, 'damage');
  assert.ok(shred.tags.includes('ad'));
  assert.ok(shred.tags.includes('ap'));
  assert.ok(!shred.tags.includes('tank'));
  assert.ok(deriveTags('造成物理伤害并治疗你自身。').tags.includes('sustain'));
});

test('internal trigger cooldowns are not haste and stat-scaled shields are defensive', () => {
  assert.deepEqual(deriveTags('你的技能可施加攻击特效。每个目标有1秒冷却时间。'), {category:'utility',tags:['onhit']});
  assert.deepEqual(deriveTags('每拥有1法术强度就会获得3护盾值。阵亡时或耗尽后70秒重置。'), {category:'defense',tags:['ap','sustain']});
  assert.ok(deriveTags('攻击特效使你的各个技能的冷却时间缩减1.25秒。').tags.includes('haste'));
  assert.equal(deriveTags('每拥有1法术强度就会造成3魔法伤害。').category, 'damage');
});

test('bundled metadata agrees with the classifier', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/augments.json', import.meta.url), 'utf8'));
  for (const row of data.augments) {
    const derived = deriveTags(row.effect);
    assert.deepEqual({category:row.category, tags:row.tags}, derived, `${row.id} ${row.name}`);
  }
});

test('curated mechanism facts retain effect provenance and official champion/item sources', () => {
  const augments = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/augments.json', import.meta.url), 'utf8'));
  const champions = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/champions.json', import.meta.url), 'utf8'));
  const mechanics = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/scoring-mechanics.json', import.meta.url), 'utf8'));
  for (const [id, fact] of Object.entries(mechanics.augments)) {
    const original = augments.augments.find(row => String(row.id) === id);
    assert.equal(fact.evidence, original.effect, id);
    assert.ok(Array.isArray(fact.limitations) && fact.limitations.length > 0, id);
  }
  assert.equal(mechanics.augments['1029'].grants[0], 'spell-on-hit');
  assert.equal(mechanics.augments['1180'].grants[0], 'shield');
  assert.ok(mechanics.itemSource.startsWith('https://ddragon.leagueoflegends.com/cdn/16.19.1/'));
  assert.equal(mechanics.items['3115'].onHit, 'unconditional');
  assert.equal(mechanics.items['3100'].onHit, 'spellblade');
  assert.equal(mechanics.flatAbilityPower['3115'], 80);
  assert.equal(new Set(mechanics.knownStatItems).size, mechanics.knownStatItems.length);
  const ekko = champions.champions.find(row => row.id === 'Ekko');
  assert.equal(ekko.spells.length, 4);
  assert.ok(ekko.passive.description.length > 0);
  assert.equal(ekko.mechanics.traits.length > 0, ekko.abilityPatch === champions.meta.patch);
  assert.ok(ekko.mechanics.limitations.some(text => text.includes('不推断额外层数')));
});
