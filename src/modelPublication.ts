import type {Session} from './domain';
import {augmentBand, ownLevel} from './level';

/** Only choice-relevant observations participate; the game clock does not expire a result. */
export function modelContextKey(session: Session): string {
  return JSON.stringify([
    session.id, session.matchId, session.ownPlayerId, session.candidateBand,
    session.candidates.map(c => [c.id, c.name, c.description, c.source]),
    session.players.map(p => [p.id, p.team, p.champion, p.augments, p.items]),
    session.notes,
  ]);
}

/** A completed model request can be archived without being suitable for the live overlay. */
export function canPublishModelRecommendation(analyzed: Session, current: Session): boolean {
  const level = ownLevel(current.liveData);
  return current.phase === 'InProgress' && !current.archived && !current.endedAt &&
    level !== null && current.candidateBand === augmentBand(level) &&
    modelContextKey(analyzed) === modelContextKey(current);
}
