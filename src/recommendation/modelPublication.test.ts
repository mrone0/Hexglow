import {describe, expect, it} from 'vitest';
import {newSession, type Session} from '../core/domain';
import {canRetainModelRecommendation,canPublishModelRecommendation, modelContextKey,snapshotModelChoice} from './modelPublication';

function playing(): Session {
  return {...newSession(), id:'session-a', matchId:'123', phase:'InProgress', candidateBand:7,
    ownPlayerId:'self', liveData:{activePlayer:{level:8}},
    players:[{id:'self',name:'',team:'ORDER',champion:'test',items:[],augments:[],augmentsConfirmed:false},
      {id:'other',name:'',team:'CHAOS',champion:'other',items:[],augments:[],augmentsConfirmed:false}],
    candidates:[{id:'a',name:'候选A',description:'效果A',source:'ocr'},{id:'b',name:'候选B',description:'效果B',source:'manual'}]};
}

describe('model result publication boundary', () => {
  it('can publish a partial comparison and retain it as an old snapshot when the roster arrives',()=>{
    const complete=playing(),partial={...complete,ownPlayerId:'',players:[]};
    expect(canPublishModelRecommendation(partial,partial)).toBe(true);
    expect(canPublishModelRecommendation(partial,complete)).toBe(false);
    expect(canRetainModelRecommendation(partial,complete)).toBe(true);
    const knownId={...partial,ownPlayerId:'self'};
    expect(canRetainModelRecommendation(knownId,complete)).toBe(true);
    expect(canRetainModelRecommendation(knownId,{...complete,ownPlayerId:'other'})).toBe(false);
    complete.players[0].augments=[complete.candidates[0].name];
    expect(canRetainModelRecommendation(partial,complete)).toBe(false);
  });
  it('copies only bounded choice facts and does not retain nested archived analysis or sample payloads',()=>{
    const input=playing();input.samples=[{at:'now',data:{sensitive:'not-needed'}}];
    input.notes='not-needed';input.decisions=[{at:'now',context:structuredClone(input),result:{ranking:[],summary:'',missingInformation:[]}}];
    const snapshot=snapshotModelChoice(input);
    expect(Object.keys(snapshot).sort()).toEqual(['candidateBand','candidates','id','matchId','ownPlayerId','players']);
    expect(snapshot.players).toHaveLength(1);
    input.players[0].augments.push('later');input.candidates[0].description='later';
    expect(snapshot.players[0].augments).toEqual([]);expect(snapshot.candidates[0].description).toBe('效果A');
  });
  it('can retain changed equipment and notes only as a previous snapshot of the same choice',()=>{
    const analyzed=playing(),current=structuredClone(analyzed);current.players[1].items.push({itemID:42});current.notes='updated';
    expect(canPublishModelRecommendation(analyzed,current)).toBe(false);
    expect(canRetainModelRecommendation(analyzed,current)).toBe(true);
    current.players[0].items.push({itemID:43});expect(canRetainModelRecommendation(analyzed,current)).toBe(true);
    current.players[0].augments.push('chosen');expect(canRetainModelRecommendation(analyzed,current)).toBe(false);
  });
  it('never retains a result across a game, band, player, hero, candidate or phase boundary',()=>{
    const analyzed=playing();
    const changes:Array<(s:Session)=>void>=[s=>{s.id='different';},s=>{s.matchId='different';},s=>{s.ownPlayerId='other';},s=>{s.players[0].champion='changed';},s=>{s.candidates[0].description='changed';},s=>{s.candidates[0].source='manual';},s=>{s.liveData={activePlayer:{level:11}};},s=>{s.phase='EndOfGame';},s=>{s.archived=true;}];
    for(const update of changes){const current=structuredClone(analyzed);update(current);expect(canRetainModelRecommendation(analyzed,current)).toBe(false);}
  });
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
