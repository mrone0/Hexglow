import {describe,expect,it} from 'vitest';
import {analysisSource} from './analysisGate';
import {newSession,type CollectorSnapshot,type Session} from './domain';

function liveFixture(){
 const session:Session={...newSession(),id:'session-1',matchId:'game-1',phase:'InProgress',ownPlayerId:'me',players:[{id:'me',name:'me',champion:'Ahri',team:'ORDER',items:[],augments:[],augmentsConfirmed:false}],liveData:{activePlayer:{level:3},gameData:{gameTime:30}}};
 const snapshot:CollectorSnapshot={platformSupported:true,connection:'lcu-and-live',phase:'InProgress',gameId:'game-1',liveData:{activePlayer:{level:7},gameData:{gameTime:210}},lcuSession:null,endOfGame:null,result:null,observedAt:'2026-10-06T11:00:00Z',warnings:[]};
 return {session,snapshot};
}

describe('model analysis source gate',()=>{
 it('takes current session state and fresh Live API values before recommending',()=>{
  const {session,snapshot}=liveFixture();
  const oldRender={...session,notes:'old render'};
  const current={...session,notes:'latest correction'};
  const selected=analysisSource('recommend',oldRender,current,snapshot,false);
  expect(selected.notes).toBe('latest correction');
  expect(selected.liveData).toBe(snapshot.liveData);
  expect(current.liveData).toBe(session.liveData);
 });

 it.each(['Lobby','EndOfGame','ChampSelect','Disconnected','Reconnect','Unknown'])('rejects retained %s sessions even when they still contain prior Live API data',phase=>{
  const {session,snapshot}=liveFixture();
  const current={...session,phase};
  expect(()=>analysisSource('recommend',current,current,{...snapshot,phase,liveData:null},false)).toThrow('本轮推荐已暂停');
 });

 it('rejects missing Live API, mismatched games and explicit historical selection',()=>{
  const {session,snapshot}=liveFixture();
  expect(()=>analysisSource('recommend',session,session,{...snapshot,liveData:null},false)).toThrow();
  expect(()=>analysisSource('recommend',session,session,{...snapshot,gameId:'next-game'},false)).toThrow();
  expect(()=>analysisSource('recommend',{...session,id:'old-session'},session,snapshot,false)).toThrow();
  expect(()=>analysisSource('recommend',session,session,snapshot,true)).toThrow();
 });

 it('rejects a disconnect or a new match discovered while local evidence was loading',()=>{
  const {session,snapshot}=liveFixture();
  const selected=analysisSource('recommend',session,session,snapshot,false);
  expect(()=>analysisSource('recommend',selected,session,{...snapshot,liveData:null},false)).toThrow();
  const next={...session,id:'session-2',matchId:'game-2'};
  expect(()=>analysisSource('recommend',selected,next,{...snapshot,gameId:'game-2'},false)).toThrow();
 });

 it('keeps retrospective reviews available without borrowing another game’s live data',()=>{
  const {session,snapshot}=liveFixture();
  const archive={...session,id:'archive',phase:'EndOfGame',archived:true,endedAt:'2026-10-06T10:00:00Z'};
  expect(analysisSource('review',archive,session,snapshot,true)).toBe(archive);
  expect(analysisSource('review',archive,session,null,false)).toBe(archive);
  expect(analysisSource('review',archive,session,null,false).liveData).toBe(archive.liveData);
 });
});
