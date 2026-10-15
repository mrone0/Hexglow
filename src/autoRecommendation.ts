import type {Session} from './domain';
import {candidateChoiceIdentity} from './choiceContext';
import {recommendationChoiceAvailable} from './localChoice';

// Two matching real captures are still required; do not wait a full second
// after a complete first frame before asking the model.
export const AUTO_STABLE_MS = 500;
// Initial panel plus one independently refreshed option for each of its three cards.
export const AUTO_MAX_PER_ROUND = 4;
export const AUTO_OBSERVATION_MAX_GAP_MS = 15_000;

type Fingerprint = {key: string; round: string};

/** Saved model snapshots may omit live-only fields; use only explicit choice identity. */
function fingerprint(value: unknown): Fingerprint | null {
  const identity=candidateChoiceIdentity(value,3);
  return identity&&(value as Session).candidates.length===3?identity:null;
}

/** Null means this observation must never start an automatic model request. */
export function autoRecommendationKey(session: Session): string | null {
  const identity = fingerprint(session);
  if (!identity || session.candidates.some(candidate => candidate.source !== 'ocr') || !recommendationChoiceAvailable(session)) return null;
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

  blockReason(session: Session): 'ineligible' | 'attempted' | 'saved' | 'round-limit' | null {
    const key = autoRecommendationKey(session);
    const identity = fingerprint(session);
    if (!key || !identity) return 'ineligible';
    const saved = key !== null && session.decisions.some(decision => !!decision.result && fingerprint(decision.context)?.key === key);
    if (saved) return 'saved';
    if (this.attempted.has(key)) return 'attempted';
    return (this.automaticPerRound.get(identity.round) ?? 0) >= AUTO_MAX_PER_ROUND ? 'round-limit' : null;
  }

  private eligibleKey(session: Session): string | null {
    return this.blockReason(session) === null ? autoRecommendationKey(session) : null;
  }

  /** Used to require a collector request begun after this choice first appeared. */
  firstObservedAt(session: Session): number | null {
    const key=this.eligibleKey(session);
    return key&&this.observation?.key===key?this.observation.firstAt:null;
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
