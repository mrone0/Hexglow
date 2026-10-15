import type {CollectorSnapshot, Session} from './domain';
import {observedChoiceBand} from './choiceContext';
import {hasGameStart} from './gameStart';

export const OCR_CONTEXT_MAX_AGE_MS = 5000;

const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Every scan entry point, including confirmation timers, shares this bound. */
export function hasFreshOcrSnapshot(snapshot: CollectorSnapshot | null, now: number): boolean {
  if (!snapshot || !validTime(now) || typeof snapshot.observedAt !== 'string' || !snapshot.observedAt.trim()) return false;
  const observedAt = Date.parse(snapshot.observedAt);
  return validTime(observedAt) && observedAt <= now && now - observedAt <= OCR_CONTEXT_MAX_AGE_MS;
}

/**
 * A separately scheduled OCR scan must not authorize a request using an older
 * round observation. The collector stamps observedAt AFTER its endpoint reads,
 * so that completion timestamp alone cannot prove the reads followed this group.
 * pollStartedAt must be the local start of the exact accepted snapshot request;
 * the caller must associate firstObservedAt with this exact candidate group.
 */
export function canAnalyzeObservedChoice(
  session: Session,
  snapshot: CollectorSnapshot | null,
  firstObservedAt: number | null | undefined,
  now: number,
  pollStartedAt: number | null | undefined,
): boolean {
  if (!validTime(now) || !validTime(firstObservedAt) || !validTime(pollStartedAt) ||
    firstObservedAt > now || pollStartedAt > now || pollStartedAt <= firstObservedAt ||
    now - pollStartedAt > OCR_CONTEXT_MAX_AGE_MS) return false;
  if (!snapshot || !session.id.trim() || !session.matchId.trim() ||
    snapshot.gameId !== session.matchId || !snapshot.connection.trim() || snapshot.connection === 'disconnected' ||
    session.phase !== 'InProgress' || snapshot.phase !== 'InProgress' || session.archived || session.endedAt) return false;
  if (!hasFreshOcrSnapshot(snapshot, now)) return false;
  const observedAt = Date.parse(snapshot.observedAt);
  if (observedAt < pollStartedAt) return false;
  const band = observedChoiceBand(session, snapshot.liveData, snapshot.observedAt);
  return band !== null && band === session.candidateBand && (band !== 1 || hasGameStart(snapshot.liveData));
}
