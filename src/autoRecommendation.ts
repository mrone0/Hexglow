import type {Session} from './domain';
import {AUGMENT_LEVELS} from './level';
import {localChoiceState} from './localChoice';

export const AUTO_STABLE_MS = 1_000;
export const AUTO_MAX_PER_ROUND = 3;
export const AUTO_OBSERVATION_MAX_GAP_MS = 15_000;

type RecordValue = Record<string, unknown>;
type Fingerprint = {key: string; round: string};
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

/** Saved model snapshots may omit live-only fields; use only explicit choice identity. */
function fingerprint(value: unknown): Fingerprint | null {
  const session = record(value);
  if (!session || !nonempty(session.id) || !nonempty(session.matchId) || !nonempty(session.ownPlayerId) ||
    !AUGMENT_LEVELS.some(band => band === session.candidateBand) || !Array.isArray(session.players) ||
    !Array.isArray(session.candidates) || session.candidates.length !== 3) return null;
  const own = session.players.map(record).filter(player => player?.id === session.ownPlayerId);
  if (own.length !== 1 || !nonempty(own[0]?.champion)) return null;
  const candidates: string[][] = [];
  for (const value of session.candidates) {
    const candidate = record(value);
    if (!candidate || !nonempty(candidate.id) || !nonempty(candidate.name) || !nonempty(candidate.description)) return null;
    candidates.push([candidate.id, candidate.name, candidate.description]);
  }
  if (new Set(candidates.map(candidate => candidate[0])).size !== candidates.length) return null;
  // Position changes, purchases, notes, knowledge and other players cannot trigger another paid request.
  candidates.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  const round = [session.id, session.matchId, session.candidateBand];
  return {round: JSON.stringify(round), key: JSON.stringify([...round, session.ownPlayerId, own[0]!.champion, candidates])};
}

/** Null means this observation must never start an automatic model request. */
export function autoRecommendationKey(session: Session): string | null {
  const identity = fingerprint(session);
  if (!identity || session.candidates.some(candidate => candidate.source !== 'ocr') || !localChoiceState(session).available) return null;
  return identity.key;
}

/** In-memory attempts include failures; saved successes also suppress requests after restart. */
export class AutoRecommendationGate {
  private observation: {key: string; firstAt: number; lastAt: number} | null = null;
  private readonly attempted = new Set<string>();
  private readonly automaticPerRound = new Map<string, number>();

  resetObservation(): void {
    this.observation = null;
  }

  private eligibleKey(session: Session): string | null {
    const key = autoRecommendationKey(session);
    const identity = fingerprint(session);
    const saved = key !== null && session.decisions.some(decision => !!decision.result && fingerprint(decision.context)?.key === key);
    return key && identity && !this.attempted.has(key) && !saved &&
      (this.automaticPerRound.get(identity.round) ?? 0) < AUTO_MAX_PER_ROUND ? key : null;
  }

  /** A pre-send check must not pretend that retained candidates were observed by OCR again. */
  isReady(session: Session, now: number): boolean {
    const key = this.eligibleKey(session), observation = this.observation;
    return Number.isFinite(now) && key !== null && observation !== null && observation.key === key &&
      now >= observation.lastAt && now - observation.lastAt <= AUTO_OBSERVATION_MAX_GAP_MS &&
      observation.lastAt - observation.firstAt >= AUTO_STABLE_MS;
  }

  /** Call only for a fresh OCR observation, not a timer replay of retained candidates. */
  observe(session: Session, now: number): boolean {
    const key = this.eligibleKey(session);
    if (!Number.isFinite(now) || !key) {
      this.resetObservation();
      return false;
    }
    const previous = this.observation;
    if (!previous || previous.key !== key || now < previous.lastAt || now - previous.lastAt > AUTO_OBSERVATION_MAX_GAP_MS) {
      this.observation = {key, firstAt: now, lastAt: now};
      return false;
    }
    this.observation = {...previous, lastAt: now};
    return this.isReady(session, now);
  }

  /** Invoke immediately before sending paid work, including manual retries; observing does not consume. */
  markAttempt(session: Session, automatic: boolean): void {
    const identity = fingerprint(session);
    if (!identity) return;
    this.attempted.add(identity.key);
    if (automatic) this.automaticPerRound.set(identity.round, (this.automaticPerRound.get(identity.round) ?? 0) + 1);
    this.resetObservation();
  }
}
