import {describe,expect,it} from 'vitest';
import {candidateChoiceIdentity,currentChoiceBand,observedChoiceBand} from './choiceContext';
import {newSession,type Session} from './domain';
import {RecommendationProgress,recommendationProgressKey} from './recommendationProgress';

const at='2026-10-12T15:00:00.000Z';
const session=():Session=>({...newSession(),id:'session',matchId:'123',phase:'InProgress',candidateBand:1,
  updatedAt:at,liveData:{gameData:{gameTime:12}},players:[],ownPlayerId:'',
  candidates:['a','b','c'].map(id=>({id,name:id,description:`effect ${id}`,source:'ocr'}))});

describe('observed choice band without fabricated roster data',()=>{
  it.each([0,12,90])('never starts from early game time %i alone',time=>{
    const s=session(),raw={gameData:{gameTime:time}},before=structuredClone(s);
    expect(observedChoiceBand(s,raw,at)).toBeNull();expect(s).toEqual(before);
  });
  it.each([-1,90.001,500,NaN,Infinity,'12',null])('rejects unknown, late or malformed time %j',time=>{
    expect(observedChoiceBand(session(),{gameData:{gameTime:time}},at)).toBeNull();
  });
  it('prioritizes actual level over an inconsistent early timestamp',()=>{
    expect(observedChoiceBand(session(),{activePlayer:{level:11},gameData:{gameTime:12}},at)).toBe(11);
  });
  it('requires a real start event with a known loading cycle, not a loading-to-running timestamp',()=>{
    const s=session();s.liveData=null;s.timeline=[{at,phase:'GameStart',connection:'lcu-only'},
      {at:'2026-10-12T15:00:02.000Z',phase:'InProgress',connection:'lcu-only'}];
    for(const observedAt of ['2026-10-12T15:00:02.000Z','2026-10-12T15:01:02.000Z','2026-10-12T18:00:02.000Z']){
      expect(observedChoiceBand(s,null,observedAt)).toBeNull();
    }
    s.ocrOpening={gameId:s.matchId,loadingObserved:true,advanced:false};
    expect(observedChoiceBand(s,{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}},'2026-10-12T18:00:02.000Z')).toBe(1);
    expect(observedChoiceBand(s,{gameData:{gameTime:500}},'2026-10-12T15:00:03.000Z')).toBeNull();
    expect(observedChoiceBand({...s,matchId:''},null,'2026-10-12T15:00:03.000Z')).toBeNull();
  });
  it('never treats an initial mid-game observation or reconnect as a new first round',()=>{
    const s=session();s.liveData=null;s.timeline=[{at,phase:'InProgress',connection:'lcu-only'}];
    expect(currentChoiceBand(s)).toBeNull();
    s.timeline=[{at,phase:'Reconnect',connection:'lcu-only'},...s.timeline];
    expect(currentChoiceBand(s)).toBeNull();
  });
  it('preserves choice and progress identity after roster data arrives',()=>{
    const before=session(),after=structuredClone(before),progress=new RecommendationProgress();
    after.ownPlayerId='me';after.players=[{id:'me',name:'',champion:'hero',team:'ORDER',items:[],augments:[],augmentsConfirmed:false}];
    const status={phase:'failed' as const,code:'http-429',message:'模型服务限流'};
    progress.set(before,status);
    expect(candidateChoiceIdentity(before)).toEqual(candidateChoiceIdentity(after));
    expect(recommendationProgressKey(before)).toBe(recommendationProgressKey(after));
    expect(progress.get(after)).toEqual(status);expect(progress.failure(after)).toEqual(status);
  });
});
