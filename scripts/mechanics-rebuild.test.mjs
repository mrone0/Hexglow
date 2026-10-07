import fs from 'node:fs';
import assert from 'node:assert/strict';
import {test} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {fetchChampions} from './fetch-data.mjs';
import {mechanicsSeedFor, renderAugment, renderChampion} from './build-knowledge.mjs';
import {withChampionMechanics} from './mechanics-data.mjs';

const champions = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/champions.json', import.meta.url), 'utf8'));
const augments = JSON.parse(fs.readFileSync(new URL('../src-tauri/data/augments.json', import.meta.url), 'utf8'));
const ekko = champions.champions.find(row => row.id === 'Ekko');

const offlineDragon = patch => async url => {
  if (url.endsWith('/api/versions.json')) return JSON.stringify([patch]);
  assert.ok(url.endsWith('/champion.json'), `unexpected request: ${url}`);
  // 官方名单接口不含技能；由抓取器的真实映射过程重建，不能依赖输出文件保留字段。
  const {abilitySource, abilityPatch, passive, spells, mechanics, ...basic} = ekko;
  return JSON.stringify({data:{Ekko:basic}});
};

test('offline champion fetch rebuild preserves reviewed official abilities and traits', async () => {
  const rebuilt = await fetchChampions(offlineDragon('16.19.1'));
  const row = rebuilt.champions[0];
  for (const field of ['abilitySource', 'abilityPatch', 'passive', 'spells', 'mechanics']) assert.deepEqual(row[field], ekko[field], field);
  const doc = renderChampion(row);
  assert.ok(doc.includes('Z型驱动共振'));
  assert.ok(doc.includes('时间卷曲器'));
  assert.ok(doc.includes('不推断额外层数'));
  assert.ok(doc.includes('官方来源'));
});

test('new patches keep provenance but disable stale reviewed scoring traits', async () => {
  const rebuilt = await fetchChampions(offlineDragon('16.20.1'));
  const row = rebuilt.champions[0];
  assert.equal(row.abilityPatch, '16.19.1');
  assert.deepEqual(row.mechanics.traits, []);
  assert.ok(row.mechanics.limitations.some(text => text.includes('评分 trait 已停用')));
  assert.ok(renderChampion(row).includes('当前基础数据为 16.20.1'));
  const unknown = {id:'NotReviewed',name:'Unknown'};
  assert.equal(withChampionMechanics(unknown, '16.19.1'), unknown);
});

test('rebuilding and statistics-import overrides retain all three targeted seed corrections', () => {
  for (const [kind,id] of [['augments','1029'],['augments','1180'],['champions','ekko']]) {
    const doc = mechanicsSeedFor(kind,id);
    const committed = fs.readFileSync(new URL(`../knowledge-seed/${kind}/${id}.md`, import.meta.url), 'utf8').replaceAll('\r\n','\n');
    assert.equal(doc, committed, `${kind}/${id} must be reproducible`);
  }
  const weapon = mechanicsSeedFor('augments',1029);
  assert.ok(!weapon.includes('"haste"'));
  assert.ok(weapon.includes('触发限制，不提供技能急速'));
  const shield = mechanicsSeedFor('augments',1180);
  assert.ok(shield.includes('category: "defense"'));
  assert.ok(shield.includes('不代表获得 AP 或直接伤害'));
  assert.equal(mechanicsSeedFor('augments',1051), null);
  assert.equal(mechanicsSeedFor('champions','ahri'), null);
});

test('a changed effect does not inherit reviewed mechanics from an old description', () => {
  const original = augments.augments.find(row => row.id === 1029);
  const changed = renderAugment({...original,effect:'新版未知效果'});
  assert.ok(!changed.includes('每目标 1 秒'));
  assert.ok(!changed.includes('只有明确攻击特效来源'));
});

test('statistics import can be loaded for audit without writing seed files', async () => {
  const before = fs.readFileSync(new URL('../knowledge-seed/champions/ekko.md', import.meta.url), 'utf8');
  await import('./import-hexdata-knowledge.mjs');
  assert.equal(fs.readFileSync(new URL('../knowledge-seed/champions/ekko.md', import.meta.url), 'utf8'), before);
});

test('the actual statistics import CLI keeps curated mechanisms in an isolated temporary dataset', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hexglow-mechanics-'));
  try {
    const cache = path.join(temporary, '.local-data', 'hexdata');
    fs.mkdirSync(cache, {recursive:true});
    fs.mkdirSync(path.join(temporary, 'src-tauri', 'src'), {recursive:true});
    fs.writeFileSync(path.join(cache,'heroes.json'), JSON.stringify({patch:'16.19.1',records:[{id:245,slug:'ekko',name:'时间刺客（艾克）'}]}));
    fs.writeFileSync(path.join(cache,'augments.json'), JSON.stringify({patch:'16.19.1',records:[{id:1029,slug:'ethereal-weapon',name:'虚幻武器'},{id:1180,slug:'big-brain',name:'超强大脑'}]}));
    execFileSync(process.execPath, [fileURLToPath(new URL('./import-hexdata-knowledge.mjs',import.meta.url))], {cwd:temporary,encoding:'utf8',stdio:'pipe'});
    for (const [kind,id] of [['augments','1029'],['augments','1180'],['champions','ekko']]) {
      assert.equal(fs.readFileSync(path.join(temporary,'knowledge-seed',kind,`${id}.md`),'utf8'),mechanicsSeedFor(kind,id));
    }
    assert.ok(!fs.existsSync(path.join(temporary,'knowledge-seed','augments','ethereal-weapon.md')));
  } finally {
    // 仅清理由本测试创建的已解析临时子目录，不使用宽泛目录作为删除目标。
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hexglow-mechanics-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
