import {describe, expect, it} from 'vitest';
import {applySnapshot, newSession, type CollectorSnapshot, type Recommendation, type Session} from './domain';
import {createLocalRecommendation, localRankingPresentation, localScoringArgs, modelRecommendation, recognizedCandidates, selectLocalRecommendation, type ScoreResult} from './liveRecommendation';

const result: ScoreResult = {
  ranking: [{id: '1068', name: '循环往复', description: '真实效果', rarity: 'gold', category: 'utility', score: 71, reason: '英雄契合', risks: []}],
  summary: '本地规则排序完成',
};

function snapshot(level = 8, gameId = '100'): CollectorSnapshot {
  return {
    platformSupported: true,
    connection: 'connected',
    phase: 'InProgress',
    gameId,
    liveData: {
      activePlayer: {summonerName: 'me', level},
      allPlayers: [{summonerName: 'me', championName: '法外狂徒', team: 'ORDER', items: []}],
      gameData: {gameTime: 180},
    },
    lcuSession: null,
    endOfGame: null,
    result: null,
    observedAt: '2026-10-06T09:00:00.000Z',
    warnings: [],
  };
}

function playing(): Session {
  const session = applySnapshot(newSession(), snapshot()).session;
  session.candidateBand = 7;
  session.candidates = [
    {id: '1068', name: '循环往复', description: '真实效果', source: 'ocr'},
    {id: '1388', name: '无限循环往复', description: '另一真实效果', source: 'ocr'},
  ];
  return session;
}

describe('main window local recommendation lifecycle', () => {
  it('retains the completed candidate snapshot and recognition time', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result, '2026-10-06T09:00:01.000Z');
    expect(local).toMatchObject({sessionId: session.id, band: 7, at: '2026-10-06T09:00:01.000Z', result});
    expect(selectLocalRecommendation(session, local)).toBe(local);
    expect(selectLocalRecommendation(session, null)).toBeNull();
  });

  it('survives ordinary live updates inside the same choice band', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    const nextSnapshot = snapshot(10);
    nextSnapshot.liveData.gameData.gameTime = 200;
    const next = applySnapshot(session, nextSnapshot).session;
    next.notes = '局势补充';
    expect(selectLocalRecommendation(next, local)).toBe(local);
  });

  it('passes observed items to scoring and invalidates a score after buying or selling', () => {
    const session = playing();
    const cached = createLocalRecommendation(session, result);
    const nextSnapshot = snapshot(10);
    nextSnapshot.liveData.allPlayers[0].items = [{itemID: 3115}];
    const next = applySnapshot(session, nextSnapshot).session;
    expect(selectLocalRecommendation(next, cached)).toBeNull();
    expect(localScoringArgs(next)).toMatchObject({champion: '法外狂徒', items: [{itemID: 3115}], owned: [], level: 7});
    const rescored = createLocalRecommendation(next, result);
    expect(selectLocalRecommendation({...next, players: next.players.map(p => ({...p, items: []}))}, rescored)).toBeNull();
  });

  it('keeps cached candidates while capture is skipped after switching to the app', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    // Foreground capture skips do not patch the session or erase the last API snapshot.
    const next = applySnapshot(session, {...snapshot(), observedAt: '2026-10-06T09:00:04.000Z'}).session;
    expect(selectLocalRecommendation(next, local)).toBe(local);
  });

  it('rejects a different game even if its champion and candidates are identical', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    const next = applySnapshot(session, snapshot(8, '101')).session;
    next.candidateBand = session.candidateBand;
    next.candidates = structuredClone(session.candidates);
    expect(next.id).not.toBe(session.id);
    expect(selectLocalRecommendation(next, local)).toBeNull();
  });

  it('rejects ended or disconnected phases without relying on candidate replacement', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    expect(selectLocalRecommendation({...session, phase: 'EndOfGame'}, local)).toBeNull();
    expect(selectLocalRecommendation({...session, phase: 'Unknown'}, local)).toBeNull();
  });

  it('rejects the previous round as soon as the next level band is observed', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    const next = applySnapshot(session, snapshot(11)).session;
    expect(next.candidateBand).toBe(7);
    expect(selectLocalRecommendation(next, local)).toBeNull();
  });

  it('requires candidates to have been recognized in the cached band', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    expect(selectLocalRecommendation({...session, candidateBand: undefined}, local)).toBeNull();
    expect(selectLocalRecommendation({...session, candidateBand: 11}, local)).toBeNull();
  });

  it.each(['id', 'name', 'description'] as const)('invalidates a changed candidate %s', field => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    const next = structuredClone(session);
    next.candidates[0][field] = '手动纠正';
    expect(selectLocalRecommendation(next, local)).toBeNull();
  });

  it('invalidates another own player, champion or owned augment context', () => {
    const session = playing();
    const local = createLocalRecommendation(session, result);
    expect(selectLocalRecommendation({...session, ownPlayerId: 'someone-else'}, local)).toBeNull();
    const changedChampion = structuredClone(session);
    changedChampion.players[0].champion = '九尾妖狐';
    expect(selectLocalRecommendation(changedChampion, local)).toBeNull();
    const changedOwned = structuredClone(session);
    changedOwned.players[0].augments.push('循环往复');
    expect(selectLocalRecommendation(changedOwned, local)).toBeNull();
  });

  it('uses the initial band when level is unknown, but still requires recognized candidates', () => {
    const session = playing();
    session.liveData = null;
    session.candidateBand = 1;
    const local = createLocalRecommendation(session, result);
    expect(local.band).toBe(1);
    expect(selectLocalRecommendation(session, local)).toBe(local);
  });

  it('does not present static metadata scores as a manually corrected effect', () => {
    const session = playing();
    session.candidates[0] = {...session.candidates[0], description: '用户纠正后的效果', source: 'manual'};
    const local = createLocalRecommendation(session, result);
    expect(selectLocalRecommendation(session, local)).toBeNull();
  });

  it('waits for an actual OCR result after manual protection is released', () => {
    const session = playing();
    session.candidates = session.candidates.map(candidate => ({...candidate, source: undefined}));
    const local = createLocalRecommendation(session, result);
    expect(selectLocalRecommendation(session, local)).toBeNull();
    const detected = {...session, candidates: session.candidates.map(candidate => ({...candidate, source: 'ocr' as const}))};
    expect(selectLocalRecommendation(detected, local)).toBe(local);
  });
});

describe('local candidate presentation confidence',()=>{
  const supported = ():ScoreResult => ({source:'model',rankingReliable:true,summary:'可靠比较',ranking:[90,90,70].map((score,index)=>({
    id:String(index),name:`候选 ${index}`,description:'效果',rarity:'gold',category:'utility',score:99,
    confidence:0.8,assessment:'supported',evidence:['已核实机制'],displayScore:score,reason:'机制理由',risks:[],
  }))});

  it('treats legacy scores as limited and never falls back to their numeric score',()=>{
    const view=localRankingPresentation(result);
    expect(view.reliable).toBe(false);
    expect(view.candidates[0]).toMatchObject({assessment:'limited',displayScore:null,rank:null,evidence:[]});
    expect(view.summary).toContain('不沿用本地规则分数');
    expect(localRankingPresentation({...result,profile:{champion:'岩雀'}}).summary).toContain('本次英雄：岩雀');
  });

  it('requires explicit reliability, supported evidence and valid display scores for every candidate',()=>{
    const variants:ScoreResult[]=[{...supported(),rankingReliable:false},{...supported(),source:undefined},{...supported(),source:'recognition'}];
    for(const change of [{assessment:'limited' as const},{assessment:'unresolved' as const},{evidence:[]},{displayScore:null},{displayScore:NaN},{displayScore:101},{confidence:null},{confidence:0.49},{confidence:1.01},{alreadyOwned:true}]){
      const value=supported();value.ranking[1]={...value.ranking[1],...change};variants.push(value);
    }
    for(const value of variants){
      const view=localRankingPresentation(value);
      expect(view.reliable).toBe(false);
      expect(view.candidates.every(candidate=>candidate.rank===null&&candidate.displayScore===null)).toBe(true);
      expect(view.candidates.map(candidate=>candidate.id)).toEqual(value.ranking.map(candidate=>candidate.id));
    }
  });

  it('uses displayScore, gives equal scores equal ranks, and never mutates backend results',()=>{
    const value=supported();value.ranking.reverse();const before=structuredClone(value);
    const view=localRankingPresentation(value);
    expect(view.reliable).toBe(true);
    expect(view.candidates.map(candidate=>candidate.displayScore)).toEqual([90,90,70]);
    expect(view.candidates.map(candidate=>candidate.rank)).toEqual([1,1,3]);
    expect(view.candidates.map(candidate=>candidate.tied)).toEqual([true,true,false]);
    expect(value).toEqual(before);
  });
});

describe('explicit recognition and dynamic model conversion',()=>{
  const recommendation=(session:Session):Recommendation=>({
    engine:{provider:'test',model:'mock',latencyMs:1,confidenceKind:'self_reported',scoringMode:'dynamic-model-v1'},
    summary:'模型按当前资料进行比较',missingInformation:[],
    ranking:session.candidates.map((candidate,index)=>({candidateId:candidate.id,score:80-index*10,
      confidence:0.8,reason:`模型理由 ${candidate.id}`,evidence:[`输入证据 ${candidate.id}`],risks:[`风险 ${candidate.id}`]})),
  });

  it('recognition preserves input effects and order but never invents a score or fit explanation',()=>{
    const session=playing(),before=structuredClone(session);
    const value=recognizedCandidates(session),view=localRankingPresentation(value);
    expect(value.source).toBe('recognition');
    expect(value.ranking.map(item=>[item.id,item.name,item.description])).toEqual(session.candidates.map(item=>[item.id,item.name,item.description]));
    expect(value.ranking.every(item=>!('score' in item)&&item.reason===''&&item.evidence?.length===0)).toBe(true);
    expect(view.label).toBe('已识别 · 待模型分析');
    expect(view.reliable).toBe(false);
    expect(session).toEqual(before);
  });

  it('maps out-of-order model IDs to real candidate metadata and sorts only the trusted presentation',()=>{
    const session=playing(),response=recommendation(session);
    response.ranking.reverse();
    const before=structuredClone(response),value=modelRecommendation(session,response),view=localRankingPresentation(value);
    expect(value.source).toBe('model');
    expect(view.reliable).toBe(true);
    expect(view.candidates.map(item=>[item.id,item.name,item.reason,item.risks])).toEqual(session.candidates.map(candidate=>[candidate.id,candidate.name,`模型理由 ${candidate.id}`,[`风险 ${candidate.id}`]]));
    expect(response).toEqual(before);
  });

  it.each(['missing','duplicate','unknown','extra-null','legacy'] as const)('refuses %s candidate/model contracts',kind=>{
    const session=playing(),response=recommendation(session);
    if(kind==='missing')response.ranking.pop();
    if(kind==='duplicate')response.ranking[1].candidateId=response.ranking[0].candidateId;
    if(kind==='unknown')response.ranking[1].candidateId='not-a-candidate';
    if(kind==='extra-null')(response.ranking as unknown[]).push(null);
    if(kind==='legacy')delete response.engine!.scoringMode;
    const view=localRankingPresentation(modelRecommendation(session,response));
    expect(view.reliable).toBe(false);
    expect(view.candidates.every(item=>item.rank===null&&item.displayScore===null)).toBe(true);
    expect(view.candidates.map(item=>item.id)).toEqual(session.candidates.map(item=>item.id));
  });

  it.each([{score:NaN},{score:Infinity},{score:-1},{score:101},{confidence:0.49},{confidence:null},{confidence:1.1},{evidence:[]},{reason:' '}])('refuses inadequate score/confidence/evidence %j',change=>{
    const session=playing(),response=recommendation(session);
    Object.assign(response.ranking[1],change);
    const view=localRankingPresentation(modelRecommendation(session,response));
    expect(view.reliable).toBe(false);
    expect(view.candidates.every(item=>item.rank===null&&item.displayScore===null)).toBe(true);
  });

  it('accepts backend-validated factor references as evidence without adding local rules',()=>{
    const session=playing(),response=recommendation(session);
    for(const item of response.ranking){item.evidence=[];item.factors=[{key:'fit',label:'适配',score:8,references:[`candidate:${item.candidateId}`]}];}
    const value=modelRecommendation(session,response);
    expect(value.rankingReliable).toBe(true);
    expect(value.ranking[0].evidence).toEqual(['引用：candidate:1068']);
  });

  it('never promotes an already-owned candidate, and conservatively hides the group ranks',()=>{
    const session=playing(),response=recommendation(session);
    response.ranking[0]={...response.ranking[0],score:0,alreadyOwned:true};
    const value=modelRecommendation(session,response),view=localRankingPresentation(value);
    expect(value.ranking[0]).toMatchObject({alreadyOwned:true,assessment:'limited',displayScore:null});
    expect(value.ranking[0].risks).toContain('当前对局已拥有，不作为新的选择。');
    expect(view.candidates.every(item=>item.rank===null&&item.displayScore===null)).toBe(true);
  });

  it('allows model analysis of manual effects and invalidates changed notes or another player build',()=>{
    const session=playing();session.candidates[0].source='manual';
    session.players.push({...structuredClone(session.players[0]),id:'other',team:'CHAOS'});
    const cached=createLocalRecommendation(session,modelRecommendation(session,recommendation(session)));
    expect(selectLocalRecommendation(session,cached)).toBe(cached);
    expect(selectLocalRecommendation({...session,notes:'new context'},cached)).toBeNull();
    const changed=structuredClone(session);changed.players[1].items.push({itemID:123});
    expect(selectLocalRecommendation(changed,cached)).toBeNull();
    expect(selectLocalRecommendation(session,createLocalRecommendation(session,recognizedCandidates(session)))).toBeNull();
  });
});
