import {describe, expect, it} from 'vitest';
import {analysisDataIssue, analysisFailure} from './analysisPreflight';
import {newSession, type Session} from './domain';

const session = (): Session => ({...newSession(), ownPlayerId: 'p1', players: [
  {id: 'p1', name: '匿名 1', champion: '刀锋舞者', team: 'ORDER', items: [], augments: [], augmentsConfirmed: false},
  {id: 'p2', name: '匿名 2', champion: '元素女皇', team: 'CHAOS', items: [{itemID: 123}], augments: ['已知条目'], augmentsConfirmed: true},
], candidates: [{id: 'a', name: '候选 A', description: '完整效果 A'}, {id: 'b', name: '候选 B', description: '完整效果 B'}]});

describe('recommendation preflight', () => {
  it('accepts a normal match without requiring confirmed augments, paid calls, or ten players', () => {
    const input = session(), before = structuredClone(input);
    expect(analysisDataIssue(input)).toBe('');
    expect(input).toEqual(before);
    input.players[1].augments = ['']; // Backend permits string arrays; unknown is not absence.
    input.candidates[1].name = input.candidates[0].name;
    input.candidates[1].description = input.candidates[0].description;
    expect(analysisDataIssue(input)).toBe(''); // Only IDs, not labels or descriptions, must be unique.
  });
  it.each([
    (value: Session) => {value.ownPlayerId = ' ';},
    (value: Session) => {value.ownPlayerId = 'missing';},
    (value: Session) => {value.players = [];},
    (value: Session) => {value.players.pop();},
    (value: Session) => {value.players[1].team = 'ORDER';},
    (value: Session) => {value.players[1].team = 'UNKNOWN';},
    (value: Session) => {value.players[1].champion = ' ';},
  ])('allows missing context without inventing roster data %#', mutate => {
    const input=session();mutate(input);const before=structuredClone(input);
    expect(analysisDataIssue(input)).toBe('');expect(input).toEqual(before);
  });
  it.each([
    (value: Session) => {value.ownPlayerId = null as unknown as string;},
    (value: Session) => {value.players[1].id = 'p1';},
    (value: Session) => {value.players[1].id = ' ';},
    (value: Session) => {value.players[1].team = 'unknown';},
    (value: Session) => {value.players[1].champion = null as unknown as string;},
    (value: Session) => {value.players[1].items = null as unknown as unknown[];},
    (value: Session) => {value.players[1].augments = null as unknown as string[];},
    (value: Session) => {value.players[1].augments = [123] as unknown as string[];},
    (value: Session) => {value.players[1].augments = new Array<string>(1);},
    (value: Session) => {value.candidates.pop();},
    (value: Session) => {value.candidates[1].id = 'a';},
    (value: Session) => {value.candidates[1].id = ' ';},
    (value: Session) => {value.candidates[1].name = ' ';},
    (value: Session) => {value.candidates[1].description = ' ';},
  ])('blocks incomplete or corrupt request data before invocation %#', mutate => {
    const input = session();mutate(input);
    const message = analysisDataIssue(input);
    expect(message).not.toBe('');
    expect(message.length).toBeLessThan(30);
    expect(message).not.toContain('匿名');
  });
  it.each([null, {}, {ownPlayerId: 'p1', players: 'invalid'}, {ownPlayerId: 'p1', players: [null, null]}])('handles malformed restored data safely %#', input => {
    expect(analysisDataIssue(input as unknown as Session)).not.toBe('');
  });
});

describe('safe analysis failure classification', () => {
  it.each([
    ['http-status-401', 'http-401', 401],
    ['HTTP 403 Forbidden', 'http-403', 403],
    ['HTTP/1.1 429 Too Many Requests', 'http-429', 429],
    ['HTTP status client error (400 Bad Request)', 'http-4xx', 400],
    ['status code: 404', 'http-4xx', 404],
    ['status code (422 Unprocessable Entity)', 'http-4xx', 422],
    ['HTTP status server error (503 Service Unavailable)', 'http-5xx', 503],
    ['HTTP status: 500', 'http-5xx', 500],
    ['request timed out', 'timeout', undefined],
    ['ETIMEDOUT', 'timeout', undefined],
    ['模型请求超时', 'timeout', undefined],
    ['error sending request', 'network', undefined],
    ['ECONNREFUSED', 'network', undefined],
    ['DNS lookup failed', 'network', undefined],
    ['响应读取失败', 'network', undefined],
    ['模型服务返回无效 JSON', 'invalid-response', undefined],
    ['模型 JSON 无效', 'invalid-response', undefined],
    ['模型未返回文本', 'invalid-response', undefined],
    ['模型结果候选 ID 必须与本次请求完全一致', 'invalid-response', undefined],
    ['Jev score 缺失', 'invalid-response', undefined],
    ['confidence 范围无效', 'invalid-response', undefined],
    ['invalid-response', 'invalid-response', undefined],
    ['其他失败', 'unknown', undefined],
  ])('classifies %s into a safe stable result', (input, code, httpStatus) => {
    const result = analysisFailure(new Error(input));
    expect(result.code).toBe(code);
    expect(result.httpStatus).toBe(httpStatus);
    expect(result.message).toMatch(/[\u4e00-\u9fff]/);
  });
  it('does not expose credentials, URLs, player names, raw payloads, or response text', () => {
    const sensitive = 'https://private.example/v1?api_key=sk-test-secret player=真实玩家 body={"token":"secret-body"}';
    for (const prefix of ['HTTP 401 ', 'HTTP 403 ', 'HTTP 429 ', 'HTTP 500 ', 'timed out ', 'network error ', '模型 JSON 无效 ', '']) {
      const result = analysisFailure(prefix + sensitive);
      const serialized = JSON.stringify(result);
      for (const forbidden of ['private.example', 'api_key', 'sk-test-secret', '真实玩家', 'secret-body', 'body=', 'https://']) expect(serialized).not.toContain(forbidden);
    }
  });
  it.each(['401', 'request id 500', 'http-status-4010', 'HTTP 5000', 'status code 4290',
    'https://private.example/http-status-401', 'https://private.example/?message=HTTP%20401', 'http-status-200'])('does not infer an HTTP failure from unrelated values: %s', input => {
    expect(analysisFailure(input)).toEqual({code: 'unknown', message: '模型分析未完成，未生成评分'});
  });
  it('uses explicit HTTP status before generic timeout wording', () => {
    expect(analysisFailure('HTTP 504 Gateway Timeout').code).toBe('http-5xx');
  });
  it('does not stringify arbitrary error payloads or trust extra status fields', () => {
    expect(analysisFailure({message: 'HTTP 429', apiKey: 'not-output'}).code).toBe('http-429');
    expect(analysisFailure({status: 401, raw: 'not-output'}).code).toBe('unknown');
    expect(analysisFailure({toString() {throw new Error('must not stringify');}}).code).toBe('unknown');
    expect(analysisFailure({get message() {throw new Error('must not crash');}}).code).toBe('unknown');
    expect(analysisFailure(null).code).toBe('unknown');
  });
});
