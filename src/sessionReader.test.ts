import {describe, expect, it} from 'vitest';
import {readSession, readSessionPage} from './sessionReader';
import {blockers, mergeLive, newSession} from './domain';

const player = () => ({id: 'me', name: '本人', champion: 'Ahri', team: 'ORDER', items: [], augments: [], augmentsConfirmed: false});
const candidate = () => ({id: '1', name: '循环往复', description: '获得技能急速。'});
const recommendation = () => ({summary: '比较结果', ranking: [{candidateId: '1', score: 70, reason: '技能收益', risks: ['资料未核验']}], missingInformation: []});
const full = () => ({
  id: 'archive', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', matchId: '123', ownPlayerId: 'me',
  players: [player()], candidates: [{...candidate(), name: '当前轮不同候选'}], notes: '', outcome: '', liveData: {private: '保留原文'},
  decisions: [{at: '2026-01-01T00:01:00Z', chosenId: '1', context: {ownPlayerId: 'me', players: [player()], candidates: [candidate()], knowledge: {documents: [{content: '原始知识'}]}, custom: '原始快照扩展'}, result: recommendation(), custom: '决策扩展'}],
  result: {status: 'win', source: 'manual', observedAt: '2026-01-02T00:00:00Z', evidence: {raw: '事实'}},
  review: {summary: '复盘', lessons: ['验证条件'], caveats: ['未知']}, samples: [{at: '2026-01-01T00:00:00Z', data: {health: 100}}],
  extra: {untouched: [1, {nested: true}]},
});

describe('persisted session reader', () => {
  it('round trips valid full records and retains each decision snapshot and unknown fields', () => {
    const source = full(), before = structuredClone(source);
    const parsed = readSession(source);
    expect(parsed).toEqual(source);
    expect(source).toEqual(before);
    expect((parsed.decisions[0].context as {candidates: {name: string}[]}).candidates[0].name).toBe('循环往复');
    expect(parsed.candidates[0].name).toBe('当前轮不同候选');
    expect(readSession(parsed)).toEqual(parsed);
  });

  it('adds compatible missing defaults without treating missing augments as confirmed', () => {
    const source = {id: 'old', players: [{id: 'me', name: '', champion: 'Ahri', team: 'ORDER'}]};
    const parsed = readSession(source);
    expect(parsed).toMatchObject({createdAt: '', matchId: '', ownPlayerId: '', candidates: [], decisions: [], notes: '', outcome: '', liveData: null});
    expect(parsed.players[0]).toMatchObject({items: [], augments: [], augmentsConfirmed: false});
    expect(source.players[0]).not.toHaveProperty('augments');
    const withSnapshotDefaults = full();
    delete (withSnapshotDefaults.decisions[0].context as {candidates?: unknown}).candidates;
    expect((readSession(withSnapshotDefaults).decisions[0].context as {candidates: unknown[]}).candidates).toEqual([]);
  });

  it('preserves honest incomplete live facts while analysis blockers remain active', () => {
    const partial = mergeLive(newSession(), {
      activePlayer: {summonerName: 'me'},
      allPlayers: [{summonerName: 'me'}, {summonerName: 'enemy', championName: 'Garen', team: 'CHAOS'}],
    });
    partial.candidates = [candidate(), {...candidate(), id: '2', name: '另一候选'}];
    const parsed = readSession(partial);
    expect(parsed).toEqual(partial);
    expect(parsed.players[0]).toMatchObject({champion: '', team: 'UNKNOWN', augmentsConfirmed: false});
    expect(blockers(parsed)).toEqual(['确认当前使用的英雄', '等待 API 提供双方阵容']);
    expect(readSessionPage([partial])).toMatchObject({invalid: 0});
    const source = full();
    const withPartialSnapshot = readSession({...source, decisions: [{...source.decisions[0], context: {...source.decisions[0].context, players: partial.players}}]});
    expect((withPartialSnapshot.decisions[0].context as {players: unknown[]}).players).toEqual(partial.players);
    for (const wrong of [{...player(), champion: null}, {...player(), champion: 1}, {...player(), team: {}}]) {
      expect(() => readSession({...source, players: [wrong]})).toThrow(/players\[0\]/);
    }
  });

  it.each([null, [], 'object', 12])('rejects non-object records (%j)', value => {
    expect(() => readSession(value)).toThrow(/session.*对象/);
  });

  it.each(['players', 'candidates', 'decisions', 'timeline', 'samples'])('rejects an explicitly malformed %s array', key => {
    expect(() => readSession({...full(), [key]: 'not-an-array'})).toThrow(new RegExp(`session.${key}.*数组`));
  });

  it.each(['id', 'name', 'champion', 'team'])('rejects players missing required %s', key => {
    const malformed: Record<string, unknown> = player();
    delete malformed[key];
    expect(() => readSession({...full(), players: [malformed]})).toThrow(new RegExp(`players\\[0\\].${key}`));
  });

  it('isolates malformed player entries and explicitly wrong nested fields', () => {
    for (const value of [null, 'player', 7, {id: 'me', name: {}, champion: 'Ahri', team: 'ORDER'}, {...player(), augments: 'effect'}, {...player(), augments: ['valid', 1]}, {...player(), augmentsConfirmed: 'false'}, {...player(), items: {}}]) {
      expect(() => readSession({...full(), players: [value]})).toThrow(/players\[0\]/);
    }
    expect(() => readSession({...full(), players: [player(), player()]})).toThrow('重复 ID');
    expect(() => readSession({...full(), notes: {instruction: 'bad'}})).toThrow(/notes.*字符串/);
  });

  it('reads legacy masked players with deterministic unique slot ids', () => {
    const masked=(champion:string,team:'ORDER'|'CHAOS')=>({...player(),id:'#',name:'#',champion,team});
    const parsed=readSession({...full(),players:[player(),masked('Garen','ORDER'),masked('Ashe','CHAOS')]});
    expect(parsed.players.map(item=>item.id)).toEqual(['me','masked:ORDER:1','masked:CHAOS:2']);
    expect(parsed.players.map(item=>item.name)).toEqual(['本人','匿名玩家 2','匿名玩家 3']);
  });

  it('requires candidate ids and names while preserving incomplete editable descriptions', () => {
    expect(readSession({...full(), candidates: [{id: 'draft', name: ''}]}).candidates[0]).toEqual({id: 'draft', name: '', description: ''});
    for (const value of [null, 'candidate', {id: 'draft'}, {name: '效果'}, {...candidate(), description: []}]) {
      expect(() => readSession({...full(), candidates: [value]})).toThrow(/candidates\[0\]/);
    }
  });

  it('rejects malformed recommendation ranking, risks, scores and renderable factor fields', () => {
    const results = [
      {...recommendation(), ranking: 'ranking'},
      {...recommendation(), ranking: [null]},
      {...recommendation(), ranking: [{...recommendation().ranking[0], risks: 'risk'}]},
      {...recommendation(), ranking: [{...recommendation().ranking[0], risks: [{}]}]},
      {...recommendation(), ranking: [{...recommendation().ranking[0], score: Infinity}]},
      {...recommendation(), ranking: [{...recommendation().ranking[0], factors: [{key: 'fit', label: {}, score: 2}]}]},
      {...recommendation(), engine: {provider: {}, model: 'local', latencyMs: 1, confidenceKind: 'unknown'}},
    ];
    for (const result of results) {
      const source = full();
      expect(() => readSession({...source, decisions: [{...source.decisions[0], result}]})).toThrow(/decisions\[0\].result/);
    }
  });

  it('rejects malformed decision snapshots instead of replacing them with current candidates', () => {
    const source = full();
    for (const snapshot of [null, 'snapshot', {candidates: 'wrong'}, {candidates: [null]}, {players: 'wrong'}, {players: [{id: 'me'}]}]) {
      expect(() => readSession({...source, decisions: [{...source.decisions[0], context: snapshot}]})).toThrow(/decisions\[0\].context/);
    }
    expect(() => readSession({...source, decisions: [{at: 'first', context: source.decisions[0].context}]})).toThrow(/decisions\[0\].result/);
  });

  it('reads old SQL summary projections without creating fake recommendation results', () => {
    const summary = {id: 'old-summary', players: [player()], sampleCount: 12, decisions: [{at: 'first', chosenId: '1'}, {at: null, chosenId: null}], result: {status: 'win'}};
    const parsed = readSession(summary, 'summary');
    expect(parsed.decisions).toHaveLength(2);
    expect(parsed.decisions[0]).not.toHaveProperty('result');
    expect(parsed.decisions[0]).not.toHaveProperty('context');
    expect(parsed.decisions[1]).toEqual({at: ''});
    expect(parsed.result).toMatchObject({status: 'win', source: 'unknown', observedAt: ''});
    expect(() => readSession(parsed)).toThrow('档案摘要');
    expect(() => readSession(summary)).toThrow(/decisions\[0\].result/);
  });

  it('handles deleted nullable reviews and unknown factor confidence without losing extensions', () => {
    const source = full();
    const parsed = readSession({...source, review: null, decisions: [{...source.decisions[0], result: {...recommendation(), ranking: [{...recommendation().ranking[0], confidence: null, evidence: ['来源'], factors: [{key: 'fit', label: '契合度', score: 2, confidence: null, reason: '未知', references: ['doc'], custom: '保留'}]}]}}]});
    expect(parsed.review).toBeNull();
    expect(parsed.decisions[0].result.ranking[0].confidence).toBeNull();
    expect(parsed.decisions[0].result.ranking[0].factors?.[0]).toHaveProperty('custom', '保留');
  });

  it('keeps pagination available when a full raw page contains isolated invalid records', () => {
    const source = Array.from({length: 50}, (_, index) => ({id: `summary-${index}`, players: [], decisions: []}));
    const values: unknown[] = [...source];
    values[3] = {id: 'bad', players: 'not-an-array'};
    values[20] = null;
    values[42] = {id: 'bad-player', players: ['not-an-object']};
    const page = readSessionPage(values);
    expect(page).toMatchObject({invalid: 3, hasNext: true});
    expect(page.sessions).toHaveLength(47);
    expect(readSessionPage(values.slice(0, 49)).hasNext).toBe(false);
    expect(readSessionPage([])).toEqual({sessions: [], invalid: 0, hasNext: false});
  });
});
