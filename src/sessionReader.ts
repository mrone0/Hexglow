import type {Candidate, Player, Recommendation, Review, Session} from './domain';

type RecordValue = Record<string, unknown>;
type Mode = 'full' | 'summary';
const summaryOnly = Symbol('session-summary-only');

function invalid(path: string, expected: string): never {
  throw new Error(`对局记录格式错误：${path} ${expected}；原始记录未被修改。`);
}
function record(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象');
  return value as RecordValue;
}
function text(value: unknown, path: string, fallback?: string, nonempty = false): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || (nonempty && !value.trim())) invalid(path, nonempty ? '必须是非空字符串' : '必须是字符串');
  return value;
}
function array(value: unknown, path: string, optional = true): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) invalid(path, '必须是数组');
  return value;
}
function strings(value: unknown, path: string, optional = true): string[] {
  return array(value, path, optional).map((item, index) => text(item, `${path}[${index}]`));
}
function number(value: unknown, path: string, min = 0, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(path, max === Infinity ? `必须是大于等于 ${min} 的有限数字` : `必须是 ${min} 至 ${max} 范围内的有限数字`);
  return value;
}
function boolean(value: unknown, path: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') invalid(path, '必须是布尔值');
  return value;
}
function optionalTextFields(source: RecordValue, path: string, fields: string[]): void {
  for (const key of fields) if (source[key] !== undefined) text(source[key], `${path}.${key}`);
}
function uniqueIds<T extends {id: string}>(items: T[], path: string): T[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) invalid(path, `包含重复 ID「${item.id}」`);
    ids.add(item.id);
  }
  return items;
}
function players(value: unknown, path: string): Player[] {
  return uniqueIds(array(value, path).map((value, index) => {
    const at = `${path}[${index}]`, player = record(value, at);
    const team = text(player.team, `${at}.team`, undefined, true);
    if (team !== 'ORDER' && team !== 'CHAOS' && team !== 'UNKNOWN') invalid(`${at}.team`, '必须是 ORDER、CHAOS 或 UNKNOWN');
    const rawId = text(player.id, `${at}.id`, undefined, true), rawName = text(player.name, `${at}.name`);
    // 旧版曾把匿名玩家的遮蔽符号「#」直接当成 ID。只对这个已知旧值生成
    // 与实时采集一致的槽位 ID；其他重复 ID 仍由 uniqueIds 严格拒绝。
    const legacyMasked = rawId.trim() === '#';
    const parsed: RecordValue = {
      ...player,
      id: legacyMasked ? `masked:${team}:${index}` : rawId,
      name: legacyMasked && rawName.trim() === '#' ? `匿名玩家 ${index+1}` : rawName,
      champion: text(player.champion, `${at}.champion`),
      team,
      items: array(player.items, `${at}.items`),
      augments: strings(player.augments, `${at}.augments`),
      augmentsConfirmed: boolean(player.augmentsConfirmed, `${at}.augmentsConfirmed`, false),
    };
    if (player.augmentSelections !== undefined) parsed.augmentSelections = array(player.augmentSelections, `${at}.augmentSelections`, false).map((value, i) => {
      const selectionPath = `${at}.augmentSelections[${i}]`, selection = record(value, selectionPath);
      if (selection.source !== 'manual-choice') invalid(`${selectionPath}.source`, '必须是 manual-choice');
      if (selection.band !== undefined) number(selection.band, `${selectionPath}.band`, 1, 18);
      return {...selection, id: text(selection.id, `${selectionPath}.id`, undefined, true), name: text(selection.name, `${selectionPath}.name`), at: text(selection.at, `${selectionPath}.at`)};
    });
    return parsed as Player;
  }), path);
}
function candidates(value: unknown, path: string): Candidate[] {
  return uniqueIds(array(value, path).map((value, index) => {
    const at = `${path}[${index}]`, candidate = record(value, at);
    if (candidate.source !== undefined && candidate.source !== 'manual' && candidate.source !== 'ocr') invalid(`${at}.source`, '必须是 manual 或 ocr');
    return {...candidate, id: text(candidate.id, `${at}.id`, undefined, true), name: text(candidate.name, `${at}.name`), description: text(candidate.description, `${at}.description`, '')} as Candidate;
  }), path);
}
function recommendation(value: unknown, path: string): Recommendation {
  const result = record(value, path);
  const ranking = array(result.ranking, `${path}.ranking`, false).map((value, index) => {
    const at = `${path}.ranking[${index}]`, item = record(value, at);
    const parsed: RecordValue = {
      ...item,
      candidateId: text(item.candidateId, `${at}.candidateId`, undefined, true),
      score: number(item.score, `${at}.score`, 0, 100),
      reason: text(item.reason, `${at}.reason`),
      risks: strings(item.risks, `${at}.risks`, false),
    };
    for (const key of ['confidence', 'modelScore', 'localScore', 'modelWeight']) {
      if (item[key] !== undefined && item[key] !== null) number(item[key], `${at}.${key}`, 0, key === 'confidence' || key === 'modelWeight' ? 1 : 100);
    }
    if (item.evidence !== undefined) parsed.evidence = strings(item.evidence, `${at}.evidence`, false);
    if (item.factors !== undefined) parsed.factors = array(item.factors, `${at}.factors`, false).map((value, i) => {
      const factorPath = `${at}.factors[${i}]`, factor = record(value, factorPath);
      text(factor.key, `${factorPath}.key`, undefined, true);
      text(factor.label, `${factorPath}.label`);
      number(factor.score, `${factorPath}.score`, 0, 4);
      if (factor.confidence !== undefined && factor.confidence !== null) number(factor.confidence, `${factorPath}.confidence`, 0, 1);
      optionalTextFields(factor, factorPath, ['reason']);
      if (factor.references !== undefined) strings(factor.references, `${factorPath}.references`, false);
      return {...factor};
    });
    return parsed;
  });
  if (result.engine !== undefined) {
    const engine = record(result.engine, `${path}.engine`);
    for (const key of ['provider', 'model', 'confidenceKind']) text(engine[key], `${path}.engine.${key}`);
    number(engine.latencyMs, `${path}.engine.latencyMs`);
    if (engine.inputBytes !== undefined) number(engine.inputBytes, `${path}.engine.inputBytes`);
  }
  return {...result, summary: text(result.summary, `${path}.summary`), ranking, missingInformation: strings(result.missingInformation, `${path}.missingInformation`)} as Recommendation;
}
function review(value: unknown, path: string): Review {
  const result = record(value, path);
  return {...result, summary: text(result.summary, `${path}.summary`), lessons: strings(result.lessons, `${path}.lessons`), caveats: strings(result.caveats, `${path}.caveats`)};
}
function context(value: unknown, path: string): RecordValue {
  const snapshot = record(value, path);
  optionalTextFields(snapshot, path, ['ownPlayerId', 'notes', 'outcome']);
  return {...snapshot, players: players(snapshot.players, `${path}.players`), candidates: candidates(snapshot.candidates, `${path}.candidates`)};
}

/** Validate persisted facts without replacing a decision's snapshot with current candidates. */
export function readSession(value: unknown, mode: Mode = 'full'): Session {
  const source = record(value, 'session');
  if (mode === 'full' && (source as Record<PropertyKey, unknown>)[summaryOnly]) invalid('session', '是档案摘要，请先读取完整对局');
  optionalTextFields(source, 'session', ['updatedAt', 'endedAt', 'patch', 'phase', 'postGameFilledAt']);
  for (const key of ['schemaVersion', 'candidateBand', 'sampleCount']) if (source[key] !== undefined) number(source[key], `session.${key}`);
  if (source.archived !== undefined) boolean(source.archived, 'session.archived');
  const decisions = array(source.decisions, 'session.decisions').map((value, index) => {
    const at = `session.decisions[${index}]`, decision = record(value, at);
    const parsed: RecordValue = {...decision, at: mode === 'summary' && decision.at === null ? '' : text(decision.at, `${at}.at`, mode === 'summary' ? '' : undefined)};
    if (decision.chosenId === null && mode === 'summary') delete parsed.chosenId;
    else if (decision.chosenId !== undefined) text(decision.chosenId, `${at}.chosenId`);
    if (mode === 'full' || (decision.result !== undefined && decision.result !== null)) parsed.result = recommendation(decision.result, `${at}.result`);
    if (mode === 'full' || (decision.context !== undefined && decision.context !== null)) parsed.context = context(decision.context, `${at}.context`);
    return parsed;
  });
  const parsed: RecordValue = {
    ...source,
    id: text(source.id, 'session.id', undefined, true),
    createdAt: text(source.createdAt, 'session.createdAt', ''),
    matchId: text(source.matchId, 'session.matchId', ''),
    ownPlayerId: text(source.ownPlayerId, 'session.ownPlayerId', ''),
    players: players(source.players, 'session.players'),
    candidates: candidates(source.candidates, 'session.candidates'),
    notes: text(source.notes, 'session.notes', ''),
    outcome: text(source.outcome, 'session.outcome', ''),
    liveData: source.liveData === undefined ? null : source.liveData,
    decisions,
  };
  if (source.result !== undefined && source.result !== null) {
    const result = record(source.result, 'session.result');
    if (!['win', 'loss', 'unknown'].includes(text(result.status, 'session.result.status'))) invalid('session.result.status', '必须是 win、loss 或 unknown');
    const origin = text(result.source, 'session.result.source', 'unknown');
    if (!['live-game-end', 'lcu-eog', 'lcu-history', 'manual', 'unknown'].includes(origin)) invalid('session.result.source', '包含未知结果来源');
    optionalTextFields(result, 'session.result', ['gameId']);
    parsed.result = {...result, source: origin, observedAt: text(result.observedAt, 'session.result.observedAt', '')};
  }
  if (source.review !== undefined && source.review !== null) parsed.review = review(source.review, 'session.review');
  for (const key of ['timeline', 'samples']) {
    if (source[key] === undefined) continue;
    parsed[key] = array(source[key], `session.${key}`, false).map((value, index) => {
      const at = `session.${key}[${index}]`, entry = record(value, at);
      optionalTextFields(entry, at, key === 'timeline' ? ['at', 'phase', 'connection'] : ['at', 'timestamp', 'capturedAt']);
      return {...entry};
    });
  }
  // Summary decisions intentionally retain absent result/context; they are never synthesized for saving.
  if (mode === 'summary') Object.defineProperty(parsed, summaryOnly, {value: true});
  return parsed as Session;
}

export function readSessionPage(values: unknown[]): {sessions: Session[]; invalid: number; hasNext: boolean} {
  if (!Array.isArray(values)) invalid('档案分页', '必须是数组');
  const sessions: Session[] = [];
  let bad = 0;
  for (const value of values) {
    try { sessions.push(readSession(value, 'summary')); }
    catch { bad++; }
  }
  return {sessions, invalid: bad, hasNext: values.length >= 50};
}
