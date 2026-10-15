import type {Player,Session} from './domain';
import {candidateChoiceIdentity,currentChoiceBand} from './choiceContext';

export type ModelChoiceSnapshot=Pick<Session,'id'|'matchId'|'ownPlayerId'|'candidateBand'|'candidates'>&{
  players:Array<Pick<Player,'id'|'champion'|'augments'|'augmentSelections'>>;
};

/** Copy only identity/selection facts; never clone samples or nested decisions on the OCR path. */
export function snapshotModelChoice(session:Session):ModelChoiceSnapshot {
  const own=session.players.find(player=>player.id===session.ownPlayerId);
  return {id:session.id,matchId:session.matchId,ownPlayerId:session.ownPlayerId,candidateBand:session.candidateBand,
    candidates:session.candidates.map(candidate=>({...candidate})),
    players:own?[{id:own.id,champion:own.champion,augments:[...own.augments],augmentSelections:own.augmentSelections?.map(selection=>({...selection}))}]:[]};
}

/** Only choice-relevant observations participate; the game clock does not expire a result. */
export function modelContextKey(session: Session): string {
  return JSON.stringify([
    session.id, session.matchId, session.ownPlayerId, session.candidateBand,
    session.candidates.map(c => [c.id, c.name, c.description, c.source]),
    session.players.map(p => [p.id, p.team, p.champion, p.augments, p.items]),
    session.notes,
  ]);
}

/** A result belongs to a choice, not to every player's continuously changing equipment. */
export function modelChoiceKey(session: Session): string | null {
  const own=session.players.find(player=>player.id===session.ownPlayerId);
  if(!candidateChoiceIdentity(session))return null;
  return JSON.stringify([session.id,session.matchId,session.ownPlayerId,own?.champion||'',session.candidateBand,
    [...(own?.augments||[])].sort(),own?.augmentSelections||[],
    session.candidates.map(c=>[c.id,c.name,c.description,c.source]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
}

/** Changed context can retain a labelled snapshot, never move it to another choice/game. */
export function canRetainModelRecommendation(analyzed: ModelChoiceSnapshot,current: Session):boolean {
  const band=currentChoiceBand(current),identity=candidateChoiceIdentity(analyzed);
  if(current.phase!=='InProgress'||current.archived||current.endedAt||band===null||current.candidateBand!==band||
    !identity||identity.key!==candidateChoiceIdentity(current)?.key)return false;
  if(analyzed.candidates.some(candidate=>current.candidates.find(other=>other.id===candidate.id)?.source!==candidate.source))return false;
  // Unknown -> known may keep the clearly labelled earlier comparison. A known
  // player/hero correction or a recorded choice must not move its recommendation.
  if(analyzed.ownPlayerId&&analyzed.ownPlayerId!==current.ownPlayerId)return false;
  const before=analyzed.players.find(player=>player.id===analyzed.ownPlayerId);
  const after=current.players.find(player=>player.id===current.ownPlayerId);
  if(before&&(!after||before.champion&&before.champion!==after.champion||
    JSON.stringify([...before.augments].sort())!==JSON.stringify([...after.augments].sort())||
    JSON.stringify(before.augmentSelections||[])!==JSON.stringify(after.augmentSelections||[])))return false;
  if(!before&&after?.augments.some(owned=>current.candidates.some(candidate=>candidate.id===owned||candidate.name.trim()===owned.trim())))return false;
  if(after?.augmentSelections?.some(selection=>selection.band===band))return false;
  return true;
}

/** A completed model request can be archived without being suitable for the live overlay. */
export function canPublishModelRecommendation(analyzed: Session, current: Session): boolean {
  const band = currentChoiceBand(current);
  return current.phase === 'InProgress' && !current.archived && !current.endedAt &&
    band !== null && current.candidateBand === band &&
    modelContextKey(analyzed) === modelContextKey(current);
}
