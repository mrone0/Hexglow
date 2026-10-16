import type {Session} from '../core/domain';

export const NEW_REQUEST_INTERVAL_MS = 1000;
export const REPEAT_REQUEST_INTERVAL_MS = 8000;
const MAX_RECENT_REQUESTS = 32;
type AnalysisMode = 'recommend' | 'review';

/** Choice identity stays in memory; late roster/owner information cannot bypass a repeat limit. */
function requestKey(mode: AnalysisMode, session: Session): string {
  if (mode === 'review') return JSON.stringify([mode, session.id, session.matchId]);
  const candidates = session.candidates.map(candidate =>
    JSON.stringify([candidate.id, candidate.name, candidate.description])).sort();
  return JSON.stringify([mode, session.id, session.matchId, session.candidateBand ?? null, candidates]);
}

/** Dispatch spacing only. Authorization, OCR stability, quotas and concurrency remain separate gates. */
export class RequestInterval {
  private readonly sent = new Map<string, number>();
  private lastSent: number | null = null;
  private overflowUntil: number | null = null;
  private rawTime: number | null = null;
  private elapsed = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Reading a wait never records an attempt or extends its deadline. */
  remaining(mode: AnalysisMode, session: Session): number {
    const now = this.now(), previous = this.sent.get(requestKey(mode, session));
    return Math.max(0,
      this.lastSent === null ? 0 : NEW_REQUEST_INTERVAL_MS - (now - this.lastSent),
      previous === undefined ? 0 : REPEAT_REQUEST_INTERVAL_MS - (now - previous),
      this.overflowUntil === null ? 0 : this.overflowUntil - now);
  }

  /** Call immediately before sending paid work; failures also keep their dispatch interval. */
  markDispatched(mode: AnalysisMode, session: Session): void {
    const now = this.now();
    for (const [key, at] of this.sent) {
      if (now - at >= REPEAT_REQUEST_INTERVAL_MS) this.sent.delete(key);
    }
    if (this.overflowUntil !== null && this.overflowUntil <= now) this.overflowUntil = null;
    const key = requestKey(mode, session);
    this.sent.delete(key);
    this.sent.set(key, now);
    this.lastSent = now;
    // A compliant caller retains at most eight recent sends. Bound even a misused
    // caller without forgetting an unexpired repeat limit and allowing a bypass.
    while (this.sent.size > MAX_RECENT_REQUESTS) {
      const [oldest, at] = this.sent.entries().next().value!;
      this.sent.delete(oldest);
      this.overflowUntil = Math.max(this.overflowUntil ?? 0, at + REPEAT_REQUEST_INTERVAL_MS);
    }
  }

  private now(): number {
    const raw = this.clock();
    if (!Number.isFinite(raw)) return this.elapsed;
    if (this.rawTime !== null) {
      const delta = Math.max(0, raw - this.rawTime);
      if (Number.isFinite(delta) && Number.isFinite(this.elapsed + delta)) this.elapsed += delta;
    }
    // performance.now is monotonic. If an injected/platform clock rolls back,
    // retain elapsed time and re-anchor once, rather than restarting the wait or
    // requiring the clock to catch up to an arbitrarily distant old timestamp.
    this.rawTime = raw;
    return this.elapsed;
  }
}
