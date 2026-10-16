import type {Session} from './domain';
import {AUGMENT_LEVELS,augmentBand,ownLevel} from './level';
import {openingWithoutLevel} from './gameStart';

/** First-round scheduling is an observation, never a fabricated player level. */
export function observedChoiceBand(session:Session,raw:unknown,_observedAt?:string):number|null {
  const level=ownLevel(raw);
  if(level!==null){
    const band=augmentBand(level);
    return band===1&&session.ocrOpening?.gameId===session.matchId&&session.ocrOpening.advanced?null:band;
  }
  return openingWithoutLevel(session,raw)?1:null;
}

export const currentChoiceBand=(session:Session):number|null=>observedChoiceBand(session,session.liveData,session.updatedAt);

const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();

/** Paid choice identity excludes facts that may arrive after the first OCR frame. */
export function candidateChoiceIdentity(value:unknown,minimumCandidates=2):{key:string;round:string}|null {
  const session=record(value);
  if(!session||!nonempty(session.id)||!nonempty(session.matchId)||!AUGMENT_LEVELS.some(band=>band===session.candidateBand)||
    !Array.isArray(session.candidates)||session.candidates.length<minimumCandidates)return null;
  const candidates:string[][]=[];
  for(const value of session.candidates){
    const candidate=record(value);
    if(!candidate||!nonempty(candidate.id)||!nonempty(candidate.name)||!nonempty(candidate.description))return null;
    candidates.push([candidate.id,candidate.name,candidate.description]);
  }
  if(new Set(candidates.map(candidate=>candidate[0])).size!==candidates.length)return null;
  candidates.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const round=[session.id,session.matchId,session.candidateBand];
  return {key:JSON.stringify([...round,candidates]),round:JSON.stringify(round)};
}
