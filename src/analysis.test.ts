import {describe,expect,it} from 'vitest';
import {AnalysisTarget} from './analysis';
import {applySnapshot,mergeLive,newSession,type CollectorSnapshot,type Recommendation} from './domain';

const raw={activePlayer:{summonerName:'me'},allPlayers:[{summonerName:'me',championName:'Ahri',team:'ORDER',items:[]}],gameData:{gameTime:15}};
const result:Recommendation={ranking:[{candidateId:'1',score:65,reason:'test',risks:[]}],summary:'test',missingInformation:[]};
const snapshot=(gameId:string,phase:string,observedAt:string,liveData:unknown|null):CollectorSnapshot=>({platformSupported:true,connection:'connected',phase,gameId,observedAt,liveData,lcuSession:null,endOfGame:null,result:null,warnings:[]});

describe('analysis during collection',()=>{
 it('appends to current evidence while keeping the original candidate context',()=>{
  const session=mergeLive(newSession(),raw);
  session.candidates=[{id:'1',name:'original',description:'original effect'}];
  const target=new AnalysisTarget(session,'2026-10-06T10:00:00Z');
  const latest={...session,candidates:[{id:'1',name:'next round',description:'next effect'}],samples:[{at:'later',data:{evidence:true}}],outcome:'new observation'};
  target.observe(latest);
  const completed=target.complete(target.snapshot,{mode:'recommend',result});
  expect(completed.candidates).toEqual(latest.candidates);
  expect(completed.samples).toEqual(latest.samples);
  expect(completed.outcome).toBe('new observation');
  expect(completed.decisions[0].context).toEqual(target.snapshot);
  expect(completed.decisions[0].at).toBe('2026-10-06T10:00:00Z');
  expect(target.snapshot.candidates[0].name).toBe('original');
 });

 it('retains final result and archive evidence when a new game starts before completion',()=>{
  let session=mergeLive(newSession(),raw);session.matchId='100';
  const target=new AnalysisTarget(session);
  const end=snapshot('100','EndOfGame','2026-10-06T10:01:00Z',{...raw,gameData:{gameTime:1200}});
  end.result={status:'win',source:'lcu-eog',gameId:'100',observedAt:end.observedAt};
  session=applySnapshot(session,end).session;target.observe(session);
  const next=applySnapshot(session,snapshot('101','InProgress','2026-10-06T10:02:00Z',raw));
  target.observe(next.completed!);target.observe(next.session);
  const completed=target.complete(target.snapshot,{mode:'recommend',result});
  expect(completed.id).toBe(session.id);
  expect(completed.matchId).toBe('100');
  expect(completed.result?.status).toBe('win');
  expect(completed.endedAt).toBe(end.observedAt);
  expect(completed.archived).toBe(true);
  expect(completed.samples).toEqual(session.samples);
  expect(next.session.decisions).toHaveLength(0);
 });

 it('applies a review without replacing newer decisions or live state',()=>{
  const session=mergeLive(newSession(),raw),target=new AnalysisTarget(session);
  const latest={...session,decisions:[{at:'newer',context:{},result}],liveData:{latest:true}};
  target.observe(latest);
  const review={summary:'review',lessons:['lesson'],caveats:[]};
  const completed=target.complete(target.snapshot,{mode:'review',result:review});
  expect(completed.review).toBe(review);
  expect(completed.decisions).toEqual(latest.decisions);
  expect(completed.liveData).toEqual({latest:true});
 });
});
