import type {CollectorSnapshot,Session} from './domain';
import {ownLevel} from './level';

export type OcrOpening={gameId:string;loadingObserved:boolean;advanced:boolean};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

/** API event evidence, not an elapsed-time heuristic or merely an HTTP success. */
export function hasGameStart(raw:unknown):boolean {
 const events=object(object(raw)?.events)?.Events;
 if(!Array.isArray(events)||events.some(event=>object(event)?.EventName==='GameEnd'))return false;
 return events.some(event=>{
  const e=object(event);
  return e?.EventName==='GameStart'&&Number.isSafeInteger(e.EventID)&&Number(e.EventID)>=0&&
   typeof e.EventTime==='number'&&Number.isFinite(e.EventTime)&&e.EventTime>=0;
 });
}

/** Persist only cycle boundaries, never a guessed current level. */
export function updateOcrOpening(session:Session,snapshot:CollectorSnapshot):OcrOpening|undefined {
 if(!session.matchId||snapshot.gameId!==session.matchId||snapshot.phase!=='InProgress'||
  !snapshot.connection.trim()||snapshot.connection==='disconnected'||session.endedAt||session.archived)return session.ocrOpening;
 const previous=session.ocrOpening?.gameId===session.matchId?session.ocrOpening:undefined;
 const timeline=session.timeline||[],first=timeline.findIndex(entry=>entry.phase==='InProgress');
 const loadingObserved=previous?previous.loadingObserved:first>0&&timeline.slice(0,first).some(entry=>['ChampSelect','GameStart'].includes(entry.phase));
 const advanced=previous?.advanced===true||(ownLevel(snapshot.liveData)??0)>=7||
  (session.candidateBand??0)>=7||session.decisions.some(decision=>Number(object(decision.context)?.candidateBand)>=7)||
  (session.samples||[]).some(sample=>(ownLevel(sample.data)??0)>=7);
 return {gameId:session.matchId,loadingObserved,advanced};
}

export function openingWithoutLevel(session:Session,raw:unknown):boolean {
 const opening=session.ocrOpening;
 return hasGameStart(raw)&&opening?.gameId===session.matchId&&opening.loadingObserved&&!opening.advanced;
}
