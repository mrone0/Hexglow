import {describe,it,expect} from 'vitest';
import {applySnapshot,hasContent,newSession,postgameEntriesOf,type CollectorSnapshot} from './domain';
const live=(time:number)=>({gameData:{gameTime:time},activePlayer:{summonerName:'me'},allPlayers:[{summonerName:'me',championName:'Ahri',team:'ORDER'},{summonerName:'enemy',championName:'Garen',team:'CHAOS'}]});
const snapshot=(extra:Partial<CollectorSnapshot>={}):CollectorSnapshot=>({platformSupported:true,connection:'lcu-and-live',phase:'InProgress',gameId:'100',liveData:live(100),lcuSession:{gameData:{gameId:100}},endOfGame:null,result:null,observedAt:'2026-01-01T00:00:00Z',warnings:[],...extra});
describe('automatic lifecycle',()=>{
 it('creates a tracked snapshot when tool opens mid-game',()=>{const s=applySnapshot(newSession(),snapshot()).session;expect(s.matchId).toBe('100');expect(s.players).toHaveLength(2);expect(s.samples).toHaveLength(1);expect(s.ownPlayerId).toBe('me');});
 it('archives on exact new match id and clears old augments',()=>{const s=applySnapshot(newSession(),snapshot()).session;s.players[0].augments=['old'];const r=applySnapshot(s,snapshot({gameId:'101',liveData:live(20)}));expect(r.completed?.id).toBe(s.id);expect(r.session.id).not.toBe(s.id);expect(r.session.players[0].augments).toEqual([]);});
 it('never infers defeat from a disconnected API',()=>{const s=applySnapshot(newSession(),snapshot()).session;const r=applySnapshot(s,snapshot({connection:'disconnected',phase:'Unknown',gameId:null,liveData:null,lcuSession:null}));expect(r.session.result?.status).toBe('unknown');expect(r.session.endedAt).toBeUndefined();expect(r.session.matchId).toBe('100');});
 it('preserves automatic results through missing data and rejects mismatched results',()=>{let s=applySnapshot(newSession(),snapshot({result:{status:'win',source:'lcu-eog',gameId:'100',observedAt:'now'}})).session;s=applySnapshot(s,snapshot({result:{status:'loss',source:'lcu-eog',gameId:'999',observedAt:'later'}})).session;expect(s.result?.status).toBe('win');});
 it('does not create a fresh game repeatedly from a live-only GameEnd event',()=>{const snap=snapshot({gameId:null,lcuSession:null,connection:'live-only',result:{status:'win',source:'live-game-end',observedAt:'now'}});const first=applySnapshot(newSession(),snap).session;const next=applySnapshot(first,snap);expect(next.completed).toBeUndefined();expect(next.session.id).toBe(first.id);});
 it('does not carry a completed result into an unidentified later game even when time increases',()=>{const a=applySnapshot(newSession(),snapshot({result:{status:'win',source:'lcu-eog',gameId:'100',observedAt:'now'}})).session;const r=applySnapshot(a,snapshot({gameId:null,lcuSession:null,connection:'live-only',liveData:live(200)}));expect(r.completed?.id).toBe(a.id);expect(r.session.matchId).toBe('');expect(r.session.result?.status).toBe('unknown');});
 it('bounds samples and deduplicates stages',()=>{let s=newSession();for(let i=0;i<245;i++)s=applySnapshot(s,snapshot({observedAt:new Date(i*15000).toISOString(),liveData:live(i*15)})).session;expect(s.samples).toHaveLength(30);expect(s.timeline).toHaveLength(1);});
 it('records end phase without claiming a result',()=>{const s=applySnapshot(newSession(),snapshot({phase:'EndOfGame',liveData:null})).session;expect(s.endedAt).toBeDefined();expect(s.result?.status).toBe('unknown');});
 it('backfills both teams augments from the post-game payload and marks them confirmed',()=>{
  const s=applySnapshot(newSession(),snapshot()).session;
  const r=applySnapshot(s,snapshot({phase:'EndOfGame',postGameAugments:{players:[{key:'me',augments:['泰坦的坚决','活力焕发']},{key:'enemy',augments:['尖端发明家']},{key:'stranger',augments:['不该出现']}],fields:['/teams/0/players/0/augments']}}));
  expect(r.session.players.find(p=>p.id==='me')?.augments).toEqual(['泰坦的坚决','活力焕发']);
  expect(r.session.players.find(p=>p.id==='me')?.augmentsConfirmed).toBe(true);
  expect(r.session.players.find(p=>p.id==='enemy')?.augments).toEqual(['尖端发明家']);
  expect(r.session.players.every(p=>!p.augments.includes('不该出现'))).toBe(true);
 });
 it('adds client observations without discarding what the player already recorded',()=>{
  let s=applySnapshot(newSession(),snapshot()).session;
  s.players[0].augments=['我手录的'];s.players[0].augmentsConfirmed=true;
  const r=applySnapshot(s,snapshot({postGameAugments:{players:[{key:'me',augments:['我手录的','尖端发明家']}],fields:[]}}));
  expect(r.session.players[0].augments).toEqual(['我手录的','尖端发明家']);
  expect(r.session.players[0].augmentsConfirmed).toBe(true);
 });
 it('never attributes post-game augments without a verifiable match id',()=>{
  const s=applySnapshot(newSession(),snapshot()).session;
  const r=applySnapshot(s,snapshot({gameId:null,postGameAugments:{players:[{key:'me',augments:['泰坦的坚决']}],fields:[]}}));
  expect(r.session.players.find(p=>p.id==='me')?.augments).toEqual([]);
 });
 it('reuses the empty champ-select shell instead of archiving an unrecognized game',()=>{
  const s=applySnapshot(newSession(),snapshot()).session;
  const ended=applySnapshot(s,snapshot({phase:'EndOfGame',liveData:null})).session;
  const shell=applySnapshot(ended,snapshot({phase:'ChampSelect',liveData:null,lcuSession:null}));
  expect(shell.completed?.id).toBe(ended.id);
  // 空壳沿用了上一局的对局 ID：新对局的 ID 到来时直接复用，不产生空档案。
  expect(shell.session.matchId).toBe('100');
  const next=applySnapshot(shell.session,snapshot({gameId:'101'}));
  expect(next.completed).toBeUndefined();
  expect(next.session.id).toBe(shell.session.id);
  expect(next.session.matchId).toBe('101');
  expect(next.session.players).toHaveLength(2);
 });
 it('attributes post-game augments by champion and team when identities are masked',()=>{
  const s=applySnapshot(newSession(),snapshot()).session;
  s.players[0].id='#';s.players[0].name='#';
  const r=applySnapshot(s,snapshot({liveData:null,postGameAugments:{players:[
   {key:'路人甲',augments:['泰坦的坚决'],champion:'Ahri',team:'ORDER'},
   {key:'路人乙',augments:['尖端发明家'],champion:'Garen',team:'CHAOS'},
   {key:'路人丙',augments:['活力焕发'],champion:'Ahri',team:'CHAOS'}
  ],fields:[]}}));
  expect(r.session.players.find(p=>p.champion==='Ahri')?.augments).toEqual(['泰坦的坚决']);
  expect(r.session.players.find(p=>p.champion==='Ahri')?.augmentsConfirmed).toBe(true);
  expect(r.session.players.find(p=>p.champion==='Garen')?.augments).toEqual(['尖端发明家']);
  expect(r.session.players.every(p=>!p.augments.includes('活力焕发'))).toBe(true);
 });
 it('refuses the champion fallback when two players share champion and team',()=>{
  const s=applySnapshot(newSession(),snapshot()).session;
  s.players[1].champion='Ahri';s.players[1].team='ORDER';
  const r=applySnapshot(s,snapshot({liveData:null,postGameAugments:{players:[{key:'路人甲',augments:['泰坦的坚决'],champion:'Ahri',team:'ORDER'}],fields:[]}}));
  expect(r.session.players.every(p=>p.augments.length===0)).toBe(true);
 });
 it('counts only sessions with real content as archivable',()=>{
  const shell=newSession();shell.matchId='123';
  expect(hasContent(shell)).toBe(false);
  shell.notes='局势补充';
  expect(hasContent(shell)).toBe(true);
  const played=newSession();played.players=[{id:'a',name:'a',champion:'Ahri',team:'ORDER',items:[],augments:[],augmentsConfirmed:false}];
  expect(hasContent(played)).toBe(true);
 });
});
describe('postgame payload shapes',()=>{
 it('reads {players,fields} and tolerates a bare array without silently yielding nothing',()=>{
  const one={key:'路人甲',augments:['泰坦的坚决'],champion:'Ahri',team:'ORDER'};
  expect(postgameEntriesOf({players:[one],fields:['/teams[0]']}).map(e=>e.key)).toEqual(['路人甲']);
  expect(postgameEntriesOf([one]).map(e=>e.key)).toEqual(['路人甲']);
  expect(postgameEntriesOf(null)).toEqual([]);
  expect(postgameEntriesOf({fields:[]})).toEqual([]);
  expect(postgameEntriesOf({players:null})).toEqual([]);
 });
});
