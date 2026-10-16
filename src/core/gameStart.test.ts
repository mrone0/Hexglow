import {describe,expect,it} from 'vitest';
import {applySnapshot,newSession,type CollectorSnapshot} from './domain';
import {hasGameStart} from './gameStart';
import {liveDetectionBand} from '../collection/detectionGate';

const started={events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}};
const snap=(phase:string,liveData:unknown=null,at='2026-10-14T00:00:00Z'):CollectorSnapshot=>({
 platformSupported:true,connection:'lcu',phase,gameId:'123',liveData,lcuSession:null,endOfGame:null,result:null,observedAt:at,warnings:[],
});

describe('real API game start and opening lifecycle',()=>{
 it('waits through a two-hour loading stall, then starts without level, roster or a clock',()=>{
  let session=applySnapshot(newSession(),snap('GameStart')).session;
  for(const at of ['2026-10-14T00:01:31Z','2026-10-14T01:00:00Z','2026-10-14T02:00:00Z']){
   const loading=snap('InProgress',{gameData:{gameTime:0}},at);
   session=applySnapshot(session,loading).session;
   expect(liveDetectionBand(session,loading,false)).toBeNull();
  }
  const playing=snap('InProgress',started,'2026-10-14T02:00:01Z');
  session=applySnapshot(session,playing).session;
  expect(liveDetectionBand(session,playing,false)).toBe(1);
  expect(session.players).toEqual([]);expect(session.liveData).toEqual(started);
  expect((session.liveData as typeof started).events.Events[0].EventTime).toBe(0);
 });
 it.each([null,{},[],{gameData:{gameTime:0}},{events:{Events:[]}},
  {events:{Events:[{EventName:'GameStart',EventTime:0}]}},
  {events:{Events:[{EventID:0,EventName:'GameStart',EventTime:'0'}]}},
  {events:{Events:[{EventID:0,EventName:'GameStart',EventTime:-1}]}},
  {events:{Events:[{EventID:Number.MAX_SAFE_INTEGER+1,EventName:'GameStart',EventTime:0}]}},
  {events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0},{EventName:'GameEnd'}]}}])('does not treat malformed/absent/ended events as a start: %j',raw=>{
   expect(hasGameStart(raw)).toBe(false);
 });
 it('does not confuse a retained GameStart on mid-game attachment with a new opening',()=>{
  const playing=snap('InProgress',started),session=applySnapshot(newSession(),playing).session;
  expect(liveDetectionBand(session,playing,false)).toBeNull();
  const known=snap('InProgress',{...started,activePlayer:{level:11}});
  expect(liveDetectionBand(applySnapshot(session,known).session,known,false)).toBe(11);
 });
 it('never falls back to the opening after a later level even before any OCR hit',()=>{
  let session=applySnapshot(newSession(),snap('ChampSelect')).session;
  const start=snap('InProgress',started);
  session=applySnapshot(session,start).session;
  expect(liveDetectionBand(session,start,false)).toBe(1);
  const later=snap('InProgress',{...started,activePlayer:{level:7}});
  session=applySnapshot(session,later).session;
  expect(liveDetectionBand(session,later,false)).toBe(7);
  expect(session.candidateBand).toBeUndefined();
  session=applySnapshot(session,start).session;
  expect(liveDetectionBand(session,start,false)).toBeNull();
  const restored=structuredClone(session);
  expect(liveDetectionBand(restored,start,false)).toBeNull();
 });
 it('isolates a new exact match and keeps the internal first-round identifier unchanged',()=>{
  let session=applySnapshot(newSession(),snap('InProgress',{activePlayer:{level:15}})).session;
  session=applySnapshot(session,{...snap('GameStart'),gameId:'456'}).session;
  const next={...snap('InProgress',started),gameId:'456'};
  session=applySnapshot(session,next).session;
  expect(session.ocrOpening?.gameId).toBe('456');
  expect(liveDetectionBand(session,next,false)).toBe(1);
  expect(liveDetectionBand(session,{...next,gameId:'123'},false)).toBeNull();
 });
});
