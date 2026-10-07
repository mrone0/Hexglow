import {fillPostGameAugments, matchingEndOfGame, mergeMatchResult, type MatchResult, type PostGameAugmentsEntry, type Session} from './domain';

type Evidence = {
  gameId?: unknown;
  players?: unknown;
  endOfGame?: unknown;
  result?: Partial<MatchResult> | null;
  observedAt?: unknown;
};

export function canRecoverPostgame(session: Session): boolean {
  return (!!session.endedAt || session.archived === true) && /^\d+$/.test(session.matchId) && session.players.length > 0;
}

/** Known gaps warrant an archive-open rescan. False is NOT proof of completeness. */
export function hasMissingPostgameEvidence(session: Session): boolean {
  return canRecoverPostgame(session) && (
    !session.result || session.result.status === 'unknown' || !session.endOfGame ||
    session.players.some(player => !player.augmentsConfirmed || !player.augments.length)
  );
}

/** A late reply may enrich only the exact archived match; never apply it as a live snapshot. */
export function mergePostgameEvidence(session: Session, payload: unknown): Session {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !session.matchId || (!session.endedAt && !session.archived)) return session;
  const evidence = payload as Evidence;
  if (evidence.gameId !== session.matchId) return session;
  let next = session;
  if (Array.isArray(evidence.players)) {
    const entries = evidence.players.filter((entry): entry is PostGameAugmentsEntry => !!entry && typeof entry === 'object' &&
      typeof entry.key === 'string' && Array.isArray(entry.augments) && entry.augments.every((a: unknown) => typeof a === 'string') &&
      (entry.champion === undefined || typeof entry.champion === 'string') && (entry.team === undefined || typeof entry.team === 'string'));
    next = fillPostGameAugments(next, entries);
  }
  const result = evidence.result;
  // Official identity-matched evidence upgrades a manual guess, but cannot overwrite
  // an already recorded automatic outcome with a conflicting late observation.
  if (result && ['lcu-eog', 'lcu-history'].includes(result.source || '') &&
      (result.status === 'win' || result.status === 'loss') && typeof result.observedAt === 'string') {
    const merged = mergeMatchResult(next.result, result, session.matchId);
    if (merged !== next.result) next = {...next, result: merged};
  }
  // Preserve the first exact-match raw evidence, just like ordinary snapshots.
  if (!next.endOfGame && matchingEndOfGame(session.matchId, evidence.endOfGame)) next = {...next, endOfGame: evidence.endOfGame};
  if (next === session) return session;
  return {...next, updatedAt: typeof evidence.observedAt === 'string' ? evidence.observedAt : new Date().toISOString()};
}

type Retry = {session: Session; attempts: number; nextAt: number; expiresAt: number};
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/** Bounded, serial retries survive lobby/new-game transitions without changing their target. */
export class PostgameRetryQueue {
  private pending = new Map<string, Retry>();
  private exhausted = new Set<string>();

  observe(session: Session, now = Date.now()): void {
    // Confirmed means the received entries were attributed, not that all choices
    // arrived. There is no reliable expected count in the client payload. Keep
    // collecting complementary fragments for the bounded budget, even after EOG.
    if (!canRecoverPostgame(session)) { this.pending.delete(session.id); return; }
    // A verified new-game transition can archive a game whose EndOfGame poll was missed.
    // updatedAt is only the observation/retry anchor, never a fabricated end time or outcome.
    const ended = Date.parse(session.endedAt || (session.archived ? session.updatedAt || '' : ''));
    if (!Number.isFinite(ended) || now >= ended + WINDOW_MS || this.exhausted.has(session.id)) return;
    const old = this.pending.get(session.id);
    if (old && old.session.matchId === session.matchId) { old.session = session; return; }
    this.pending.set(session.id, {session, attempts: 0, nextAt: now + 3000, expiresAt: ended + WINDOW_MS});
    if (this.pending.size > 3) this.pending.delete(this.pending.keys().next().value!);
  }

  take(now = Date.now()): Session | null {
    for (const [id, retry] of this.pending) {
      if (now >= retry.expiresAt || retry.attempts >= MAX_ATTEMPTS) { this.forget(id); continue; }
      if (now < retry.nextAt) continue;
      retry.attempts++;
      retry.nextAt = now + Math.min(60000, 3000 * 2 ** retry.attempts);
      return retry.session;
    }
    return null;
  }

  forget(id: string): void {
    this.pending.delete(id);
    this.exhausted.add(id);
    if (this.exhausted.size > 100) this.exhausted.delete(this.exhausted.values().next().value!);
  }
}
