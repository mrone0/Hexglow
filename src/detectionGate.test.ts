import {describe,expect,it} from 'vitest';
import {newSession,type CollectorSnapshot,type Session} from './domain';
import {liveDetectionBand} from './detectionGate';

function fixture(){
 const session:Session={...newSession(),id:'session',phase:'InProgress',matchId:'game',ownPlayerId:'me',players:[{id:'me',name:'me',champion:'Ahri',team:'ORDER',items:[],augments:[],augmentsConfirmed:false}],candidateBand:7,candidates:[{id:'augment',name:'保留候选',description:'已识别效果',source:'ocr'}],liveData:{activePlayer:{level:8},gameData:{gameTime:400}}};
 const snapshot:CollectorSnapshot={platformSupported:true,connection:'lcu-and-live',phase:'InProgress',gameId:'game',liveData:session.liveData,lcuSession:null,endOfGame:null,result:null,observedAt:'2026-10-06T11:00:00Z',warnings:[]};
 return {session,snapshot};
}

describe('automatic OCR and overlay signal gate',()=>{
 it('suspends a pending scan after missing live data and resumes the same round without deleting recorded candidates',()=>{
  const {session,snapshot}=fixture();
  const original=structuredClone(session);
  const scanBand=liveDetectionBand(session,snapshot,false);
  expect(scanBand).toBe(7);
  expect(liveDetectionBand(session,{...snapshot,connection:'lcu-only',liveData:null},false)).toBeNull();
  expect(liveDetectionBand(session,{...snapshot,connection:'lcu-only',liveData:null},false)===scanBand).toBe(false);
  expect(session).toEqual(original);
  expect(liveDetectionBand(session,snapshot,false)).toBe(scanBand);
 });

 it.each(['Lobby','EndOfGame','ChampSelect','Disconnected','Reconnect'])('does not scan or republish retained candidates in %s',phase=>{
  const {session,snapshot}=fixture();
  expect(liveDetectionBand({...session,phase},{...snapshot,phase},false)).toBeNull();
 });

 it('invalidates an in-flight old-band scan when fresh player level advances',()=>{
  const {session,snapshot}=fixture();
  const oldBand=liveDetectionBand(session,snapshot,false);
  const current=liveDetectionBand(session,{...snapshot,liveData:{activePlayer:{level:11},gameData:{gameTime:600}}},false);
  expect(current).toBe(11);
  expect(current).not.toBe(oldBand);
 });

 it('does not infer a round from old player level when the new Live API payload lacks level',()=>{
  const {session,snapshot}=fixture();
  expect(liveDetectionBand(session,{...snapshot,liveData:{gameData:{gameTime:500}}},false)).toBeNull();
  expect(liveDetectionBand(session,{...snapshot,liveData:{activePlayer:{level:3}}},false)).toBe(1);
 });

 it('rejects a different game, completed session, explicit history and missing snapshot',()=>{
  const {session,snapshot}=fixture();
  expect(liveDetectionBand(session,{...snapshot,gameId:'different-game'},false)).toBeNull();
  expect(liveDetectionBand({...session,endedAt:snapshot.observedAt},snapshot,false)).toBeNull();
  expect(liveDetectionBand(session,snapshot,true)).toBeNull();
  expect(liveDetectionBand(session,null,false)).toBeNull();
 });
});
