import {describe, expect, it} from 'vitest';
import {normalizeRecommendationStatus} from './recommendationStatus';

describe('recommendation status publications', () => {
  it.each(['waiting', 'preparing', 'analyzing', 'blocked', 'failed', 'complete'])('accepts a bounded %s status without retaining extra fields', phase => {
    const input = {phase, code: 'model-timeout', message: '请求超时，可在主窗口重试', extra: 'not displayed'};
    expect(normalizeRecommendationStatus(input)).toEqual({phase, code: 'model-timeout', message: input.message});
    expect(normalizeRecommendationStatus(input)).not.toBe(input);
  });
  it.each([undefined, null, false, 12, [], 'failed', {},
    {phase: 'invented', code: 'test', message: '不可信状态'},
    {phase: 'failed', code: '', message: '缺少状态码'},
    {phase: 'failed', code: 'unsafe/code', message: '非法状态码'},
    {phase: 'failed', code: 'x'.repeat(65), message: '过长状态码'},
    {phase: 'failed', code: 'test', message: 1},
    {phase: 'failed', code: 'test', message: ' \n\u202e\u0000 '},
  ])('falls back to waiting for malformed external data %#', input => {
    expect(normalizeRecommendationStatus(input)).toEqual({phase: 'waiting', code: 'waiting', message: '等待稳定候选'});
  });
  it('keeps status text single-line, removes direction controls, and caps Unicode characters', () => {
    expect(normalizeRecommendationStatus({phase: 'blocked', code: 'daily-limit', message: ' 今日\n\t次数\u202e已用完\u0000 '}))
      .toEqual({phase: 'blocked', code: 'daily-limit', message: '今日 次数 已用完'});
    const result = normalizeRecommendationStatus({phase: 'failed', code: 'timeout', message: '🌸'.repeat(100)});
    expect(Array.from(result.message)).toHaveLength(80);
    expect(result.message.endsWith('…')).toBe(true);
    expect(result.message).not.toContain('\ufffd');
  });
});
