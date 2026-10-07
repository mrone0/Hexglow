import {describe, expect, it} from 'vitest';
import {newSession, type Session} from './domain';
import {canPublishModelRecommendation, modelContextKey} from './modelPublication';

function playing(): Session {
  return {...newSession(), id:'session-a', matchId:'123', phase:'InProgress', candidateBand:7,
    ownPlayerId:'self', liveData:{activePlayer:{level:8}},
    players:[{id:'self',name:'',team:'ORDER',champion:'test',items:[],augments:[],augmentsConfirmed:false},
      {id:'other',name:'',team:'CHAOS',champion:'other',items:[],augments:[],augmentsConfirmed:false}],
    candidates:[{id:'a',name:'候选A',description:'效果A',source:'ocr'},{id:'b',name:'候选B',description:'效果B',source:'manual'}]};
}

describe('model result publication boundary', () => {
  it('allows the same choice including manually corrected candidates', () => {
    const session=playing();
    expect(canPublishModelRecommendation(session,structuredClone(session))).toBe(true);
  });
  it('does not expire merely because the clock, sample count or same-band level advanced', () => {
    const session=playing(), current=structuredClone(session);
    current.liveData={activePlayer:{level:10},gameData:{gameTime:300}};
    current.sampleCount=30;current.updatedAt='later';
    expect(canPublishModelRecommendation(session,current)).toBe(true);
  });
  it.each(['id','matchId','ownPlayerId','notes'] as const)('rejects a changed %s', field => {
    const session=playing(),current=structuredClone(session);current[field]='changed';
    expect(canPublishModelRecommendation(session,current)).toBe(false);
  });
  it('rejects candidate rerolls and corrected effects', () => {
    const session=playing(),current=structuredClone(session);current.candidates[0].description='纠正';
    expect(canPublishModelRecommendation(session,current)).toBe(false);
    current.candidates[0]={...session.candidates[0],id:'c'};
    expect(canPublishModelRecommendation(session,current)).toBe(false);
  });
  it('rejects changed observed items, augments or opposing roster', () => {
    for(const change of [(s:Session)=>s.players[0].items.push({itemID:42}),
      (s:Session)=>s.players[0].augments.push('new'),(s:Session)=>{s.players[1].champion='changed';}]){
      const session=playing(),current=structuredClone(session);change(current);
      expect(canPublishModelRecommendation(session,current)).toBe(false);
    }
  });
  it('rejects ended games and later choice bands even if the old candidates remain', () => {
    const session=playing();
    for(const changes of [{phase:'EndOfGame'},{archived:true},{endedAt:'now'},
      {liveData:{activePlayer:{level:11}}},{liveData:null}]){
      expect(canPublishModelRecommendation(session,{...session,...changes})).toBe(false);
    }
  });
  it('ignores player display names when comparing game observations', () => {
    const session=playing(),current=structuredClone(session);current.players[0].name='different';
    expect(modelContextKey(session)).toBe(modelContextKey(current));
  });
});
