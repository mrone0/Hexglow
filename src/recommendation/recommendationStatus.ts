export type RecommendationStatus = {
  phase: 'waiting' | 'preparing' | 'analyzing' | 'blocked' | 'failed' | 'complete';
  code: string;
  message: string;
};

const PHASES = new Set<RecommendationStatus['phase']>(['waiting', 'preparing', 'analyzing', 'blocked', 'failed', 'complete']);

/** Publications cross a window boundary: never trust an arbitrary status object. */
export function normalizeRecommendationStatus(value: unknown): RecommendationStatus {
  const waiting: RecommendationStatus = {phase: 'waiting', code: 'waiting', message: '等待稳定候选'};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return waiting;
  const input = value as Record<string, unknown>;
  if (typeof input.phase !== 'string' || !PHASES.has(input.phase as RecommendationStatus['phase']) ||
      typeof input.code !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(input.code) ||
      typeof input.message !== 'string') return waiting;
  const message = input.message.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!message) return waiting;
  const characters = Array.from(message);
  return {phase: input.phase as RecommendationStatus['phase'], code: input.code,
    message: characters.length > 80 ? `${characters.slice(0, 79).join('')}…` : message};
}
