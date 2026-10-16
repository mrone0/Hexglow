import {describe, expect, it} from 'vitest';
import {modelDestination} from './modelConsent';

describe('model authorization destination', () => {
  it('retains authorization for harmless URL formatting but not another endpoint', () => {
    const original = modelDestination({provider: 'jev', baseUrl: 'https://api.typesafe.ai/v1'});
    expect(modelDestination({provider: 'jev', baseUrl: ' https://api.typesafe.ai:443/v1/ '})).toBe(original);
    expect(modelDestination({provider: 'jev', baseUrl: 'https://example.com/v1'})).not.toBe(original);
    expect(modelDestination({provider: 'jev', baseUrl: 'https://api.typesafe.ai/other'})).not.toBe(original);
    expect(modelDestination({provider: 'openai', baseUrl: 'https://api.typesafe.ai/v1'})).not.toBe(original);
  });
  it('does not approve malformed URLs or credential-bearing endpoints', () => {
    for (const baseUrl of ['', 'invalid', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) {
      expect(modelDestination({baseUrl})).toBe('');
    }
  });
});
