import type {ComponentProps} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {LiveOverview,liveOverviewState} from './LiveOverview';
import {newSession, type CollectorSnapshot, type Recommendation, type Session} from './domain';
import {createLocalRecommendation, modelRecommendation, recognizedCandidates, type ScoreResult} from './liveRecommendation';
import {confirmLocalChoice} from './localChoice';

const observedAt = '2026-10-06T08:20:04.000Z';
const scored: ScoreResult = {
  source: 'model',
  summary: '根据法外狂徒与本轮候选完成本地比较',
  rankingReliable: true,
  ranking: [
    {id: '1068', name: '循环往复', description: '候选效果一', rarity: 'gold', category: 'utility', score: 81, displayScore: 81, confidence: 0.8, assessment: 'supported', evidence: ['已核实机制一'], reason: '模型英雄契合理由', risks: ['仍需结合战局判断']},
    {id: '1388', name: '无限循环往复', description: '候选效果二', rarity: 'prismatic', category: 'damage', score: 73, displayScore: 73, confidence: 0.8, assessment: 'supported', evidence: ['已核实机制二'], reason: '模型另一候选理由', risks: []},
  ],
};

function sessionFixture(): Session {
  return {
    ...newSession(),
    id: 'live-game',
    matchId: '100',
    phase: 'InProgress',
    ownPlayerId: 'me',
    players: [{id: 'me', name: 'me', champion: '法外狂徒', team: 'ORDER', items: [], augments: ['已确认海克斯'], augmentsConfirmed: false}],
    candidateBand: 7,
    candidates: scored.ranking.map(candidate => ({id: candidate.id, name: candidate.name, description: candidate.description, source: 'ocr'})),
    liveData: {activePlayer: {level: 8}, gameData: {gameTime: 245}},
  };
}

function snapshotFixture(session: Session): CollectorSnapshot {
  return {
    platformSupported: true,
    connection: 'connected',
    phase: 'InProgress',
    gameId: session.matchId,
    liveData: session.liveData,
    lcuSession: null,
    endOfGame: null,
    result: null,
    observedAt,
    warnings: [],
  };
}

function modelDecision(session:Session):Session['decisions'][number]{
  const result:Recommendation={summary:'本次模型总结',missingInformation:[],
    engine:{provider:'test',model:'mock',latencyMs:1,confidenceKind:'self_reported',scoringMode:'dynamic-model-v1'},
    ranking:session.candidates.map((candidate,index)=>({candidateId:candidate.id,score:80-index*10,confidence:0.8,reason:'模型提供的理由',evidence:['候选效果和已知阵容'],risks:[]}))};
  return {at:observedAt,context:structuredClone(session),result};
}

function render(session = sessionFixture(), overrides: Partial<ComponentProps<typeof LiveOverview>> = {}): string {
  const noop = () => {};
  return renderToStaticMarkup(<LiveOverview
    session={session}
    snapshot={snapshotFixture(session)}
    auto={true}
    localRecommendation={createLocalRecommendation(session, scored, observedAt)}
    detectionMessage="游戏不在前台，保留已识别候选。"
    onSync={noop}
    busy={false}
    ready={false}
    setupIssue="请先在本地设置勾选发送前确认。"
    blockers={[]}
    onRun={noop}
    onSettings={noop}
    onPatch={noop}
    onResume={noop}
    historical={false}
    {...overrides}
  />);
}

describe('main app realtime recommendation rendering', () => {
  it('shows recognition only before model analysis, without inferred scores or recommendation emphasis',()=>{
    const session=sessionFixture();
    const html=render(session,{localRecommendation:createLocalRecommendation(session,recognizedCandidates(session),observedAt)});
    expect(html).toContain('已识别 · 待模型分析');
    expect(html).toContain('本轮已识别候选');
    expect(html).toContain('尚未进行模型分析，风险未评估');
    expect(html).not.toContain('local-candidate top');
    expect(html).not.toContain('<small> 分</small>');
    expect(html).not.toContain('本地规则 · 非 AI');
  });

  it('only emphasizes a same-context model snapshot with usable evidence and a matching active cache',()=>{
    const session=sessionFixture(),decision=modelDecision(session);
    session.decisions=[decision];
    const html=render(session,{localRecommendation:createLocalRecommendation(session,modelRecommendation(session,decision.result),decision.at)});
    expect(html).toContain('本轮分析快照');
    expect(html).toContain('class="choice-slot recommended"');
    expect(html).toContain('模型比较 · 第1名');
    expect(html).not.toContain('海萤优先推荐');
  });

  it('does not promote the first model entry when confidence, evidence or owned status forbids ranking',()=>{
    for(const change of [{confidence:0.1},{evidence:[]},{alreadyOwned:true,score:0}]){
      const session=sessionFixture(),decision=modelDecision(session);
      Object.assign(decision.result.ranking[0],change);session.decisions=[decision];
      const html=render(session,{localRecommendation:createLocalRecommendation(session,modelRecommendation(session,decision.result),decision.at)});
      expect(html).toContain('比较方案');
      expect(html).not.toContain('class="choice-slot recommended"');
      expect(html).not.toContain('模型推荐方案');
      expect(html).not.toContain('海萤优先推荐');
    }
  });

  it.each(['notes','items','candidate','no-cache','recognition-cache','different-analysis'] as const)('marks a %s model snapshot historical without deleting its rationale',change=>{
    const session=sessionFixture(),decision=modelDecision(session);
    session.decisions=[decision];
    let cache:ReturnType<typeof createLocalRecommendation>|null=createLocalRecommendation(session,modelRecommendation(session,decision.result),decision.at);
    if(change==='notes')session.notes='新局势';
    if(change==='items')session.players[0].items.push({itemID:123});
    if(change==='candidate')session.candidates[0].description='修订效果';
    if(change==='no-cache')cache=null;
    if(change==='recognition-cache')cache=createLocalRecommendation(session,recognizedCandidates(session),decision.at);
    if(change==='different-analysis')cache={...cache!,at:'2026-10-06T08:21:00Z'};
    const html=render(session,{localRecommendation:cache});
    expect(html).toContain('历史分析快照，仅供查看');
    expect(html).toContain('模型提供的理由');
    expect(html).not.toContain('class="choice-slot recommended"');
    expect(html).not.toContain('模型推荐方案');
  });

  it('retains this-round confirmation after owned augments invalidate the model ranking context',()=>{
    const session=sessionFixture(),decision=modelDecision(session);
    session.decisions=[decision];
    const cache=createLocalRecommendation(session,modelRecommendation(session,decision.result),decision.at);
    const confirmed=confirmLocalChoice(session,'1068');
    const html=render(confirmed,{localRecommendation:cache});
    expect(html).toContain('本轮已确认');
    expect(html).toContain('本轮选择已确认并锁定');
    expect(html).toContain('历史分析快照，仅供查看');
    expect(html).not.toContain('class="choice-slot recommended"');
    const changed={...confirmed,candidates:confirmed.candidates.map((candidate,index)=>index?candidate:{...candidate,description:'另一套候选效果'})};
    expect(render(changed,{localRecommendation:cache})).toContain('历史已确认');
  });

  it('retains an explicitly sourced model comparison while setup is currently unavailable', () => {
    const html = render();
    expect(html).toContain('本轮模型推荐');
    expect(html).not.toContain('本地规则 · 非 AI');
    expect(html).toContain('循环往复');
    expect(html).toContain('无限循环往复');
    expect(html).toContain('81<small> 分</small>');
    expect(html).toContain('模型英雄契合理由');
    expect(html).toContain('配置模型分析');
    expect(html).not.toContain('等待本轮海克斯候选');
    expect(html).not.toContain('上次模型分析');
  });

  it('shows legacy or unresolved candidates without numeric scores, ranks or preferred styling',()=>{
    const session=sessionFixture();
    const legacy:ScoreResult={...scored,ranking:scored.ranking.map(({assessment,evidence,displayScore,...candidate})=>candidate)};
    const unresolved:ScoreResult={...scored,ranking:scored.ranking.map((candidate,index)=>index?{...candidate,assessment:'unresolved',displayScore:null}:candidate)};
    for(const value of [legacy,unresolved,{...scored,rankingReliable:false}]){
      const html=render(session,{localRecommendation:createLocalRecommendation(session,value,observedAt)});
      expect(html).toContain('本轮模型推荐');
      expect(html).toContain('暂不排名或给分');
      expect(html).toContain('模型英雄契合理由');
      expect(html).toContain('候选效果一');
      expect(html).toContain('仍需结合战局判断');
      expect(html).not.toContain('local-candidate top');
      expect(html).not.toContain('优先推荐');
      expect(html).not.toContain('第1名');
      expect(html).not.toContain('<small> 分</small>');
    }
  });

  it('gives equally supported candidates equal ranks and exposes their evidence',()=>{
    const session=sessionFixture();
    const value={...scored,ranking:scored.ranking.map(candidate=>({...candidate,displayScore:81}))};
    const html=render(session,{localRecommendation:createLocalRecommendation(session,value,observedAt)});
    expect(html.match(/并列第1名/g)).toHaveLength(2);
    expect(html.match(/local-candidate top/g)).toHaveLength(2);
    expect(html).toContain('已核实机制一');
    expect(html).toContain('已核实机制二');
    expect(html).toContain('模型比较分 81，非胜率');
  });

  it('shows live level, elapsed time, owned augments and synchronization outside advanced tools', () => {
    const html = render();
    expect(html).toContain('aria-label="实时对局状态"');
    expect(html).toContain('Lv.8');
    expect(html).toContain('4:05');
    expect(html).toContain('connected');
    expect(html).toContain(new Date(observedAt).toLocaleTimeString());
    expect(html).toContain('本人已选海克斯：已确认海克斯');
    expect(html).toContain('自动跟踪中');
    expect(html).toContain('立即同步');
    expect(html).toContain('游戏不在前台，保留已识别候选。');
    expect(html).toContain('保留本轮模型分析快照');
  });

  it('keeps unavailable level and game time unknown instead of fabricating zero values', () => {
    const session = sessionFixture();
    session.liveData = {activePlayer: {}, gameData: {}};
    session.players[0].augments = [];
    const html = render(session, {snapshot: null, localRecommendation: null});
    expect(html).toContain('记录等级</span><strong>—</strong>');
    expect(html).toContain('记录时长</span><strong>—</strong>');
    expect(html).toContain('等待同步');
    expect(html).toContain('已记录的本人海克斯：尚未识别');
    expect(html).not.toContain('Lv.0');
    expect(html).not.toContain('<strong>0:00</strong>');
  });

  it('keeps a previous model snapshot below the new local candidates', () => {
    const session = sessionFixture();
    const previousContext = structuredClone(session);
    previousContext.candidateBand = 1;
    previousContext.candidates = [{id: 'previous', name: '上一轮候选', description: '上一轮效果'}];
    session.decisions = [{
      at: '2026-10-06T08:10:00.000Z',
      context: previousContext,
      result: {ranking: [{candidateId: 'previous', score: 90, reason: '上次模型理由', risks: []}], summary: '上次模型总结', missingInformation: []},
    }];
    const html = render(session);
    expect(html).toContain('本轮模型推荐');
    expect(html).toContain('循环往复');
    expect(html).toContain('上一轮候选');
    expect(html).toContain('上次模型分析');
    expect(html.indexOf('本轮模型推荐')).toBeLessThan(html.indexOf('上次模型分析'));
    expect(html.indexOf('循环往复')).toBeLessThan(html.indexOf('上一轮候选'));
    expect(html).not.toContain('等待本轮海克斯候选');
    expect(html).toContain('历史分析快照，仅供查看');
    expect(html).not.toContain('我选了这个');
    expect(html.match(/我选了「/g)).toHaveLength(2);
  });

  it('drops the previous score in the next band while keeping recorded candidates visible', () => {
    const session = sessionFixture();
    const local = createLocalRecommendation(session, scored, observedAt);
    session.liveData = {activePlayer: {level: 11}, gameData: {gameTime: 700}};
    const html = render(session, {localRecommendation: local});
    expect(html).toContain('Lv.11');
    expect(html).toContain('aria-label="已记录候选"');
    expect(html).toContain('待模型分析');
    expect(html).toContain('上一轮已记录候选');
    expect(html).toContain('等待第3轮的新候选');
    expect(html).toContain('循环往复');
    expect(html).toContain('候选效果一');
    expect(html).not.toContain('本轮模型推荐');
    expect(html).not.toContain('81<small> 分</small>');
    expect(html).not.toContain('等待本轮海克斯候选');
  });

  it('keeps manual effects visible without presenting an old static score', () => {
    const session = sessionFixture();
    const previous = createLocalRecommendation(session, scored, observedAt);
    session.candidates[0] = {...session.candidates[0], description: '手动核实的效果', source: 'manual'};
    const html = render(session, {localRecommendation: previous});
    expect(html).toContain('手动核实的效果');
    expect(html).toContain('手动候选已保留；点击模型分析后按当前效果比较');
    expect(html).not.toContain('81<small> 分</small>');
  });

  it('opens all local candidate effects and risks by default',()=>{
    const session=sessionFixture();
    const third={id:'1170',name:'万用瞄准镜',description:'第三个效果',rarity:'silver',category:'utility',score:60,reason:'第三项理由',risks:[]};
    const result={...scored,ranking:[...scored.ranking,third]};
    session.candidates.push({id:third.id,name:third.name,description:third.description,source:'ocr'});
    const html=render(session,{localRecommendation:createLocalRecommendation(session,result,observedAt)});
    expect(html.match(/<details open=""><summary>效果与注意事项<\/summary>/g)).toHaveLength(3);
    expect(html).toContain('仍需结合战局判断');
    expect(html).toContain('暂无额外注意事项');
  });

  it('uses one current-round confirmation area even with a model analysis',()=>{
    const session=sessionFixture();
    session.decisions=[{at:observedAt,context:structuredClone(session),result:{ranking:[{candidateId:'1068',score:80,reason:'模型理由',risks:[]}],summary:'模型总结',missingInformation:[]}}];
    const html=render(session);
    expect(html.match(/class="local-choice-controls"/g)).toHaveLength(1);
    expect(html.match(/我选了「/g)).toHaveLength(2);
    expect(html).not.toContain('我选了这个');
    const chosen=confirmLocalChoice(session,'1068');
    const locked=render(chosen);
    expect(locked).toContain('本轮已记录「循环往复」，选择已锁定');
    expect(locked).toContain('本轮已确认');
    expect(locked).not.toContain('我选了「');
    expect(locked).not.toContain('我选了这个');
  });

  it('keeps previous confirmations read-only and allows controls only for the new band',()=>{
    const session=sessionFixture();
    const previousContext={...structuredClone(session),candidateBand:1};
    session.decisions=[{at:observedAt,context:previousContext,chosenId:'1068',result:{ranking:[{candidateId:'1068',score:80,reason:'上一轮模型理由',risks:[]}],summary:'上一轮总结',missingInformation:[]}}];
    const html=render(session);
    expect(html).toContain('历史已确认');
    expect(html).toContain('历史分析快照，仅供查看');
    expect(html.match(/我选了「/g)).toHaveLength(2);
    const historical=render(session,{historical:true});
    expect(historical).toContain('历史已确认');
    expect(historical).not.toContain('我选了「');
    expect(historical).not.toContain('我选了这个');
  });
});

describe('live versus retained session presentation',()=>{
 it.each([
  ['live','InProgress','InProgress',true,'connected',false,'live'],
  ['lobby','Lobby','Lobby',false,'lcu-only',false,'previous'],
  ['ended','EndOfGame','EndOfGame',true,'lcu-and-live',false,'previous'],
  ['champion selection','ChampSelect','ChampSelect',false,'lcu-only',false,'previous'],
  ['disconnected','Disconnected','Disconnected',false,'disconnected',false,'unavailable'],
  ['running without Live API','InProgress','InProgress',false,'lcu-only',false,'unavailable'],
  ['stale session phase','InProgress','Disconnected',false,'disconnected',false,'unavailable'],
  ['disconnected with retained payload','InProgress','InProgress',true,'disconnected',false,'unavailable'],
  ['explicit history','InProgress','InProgress',true,'connected',true,'historical'],
 ] as const)('%s chooses the appropriate source and status',(_name,sessionPhase,snapshotPhase,hasLive,connection,historical,mode)=>{
  const session={...sessionFixture(),phase:sessionPhase};
  const snapshot={...snapshotFixture(session),phase:snapshotPhase,connection,liveData:hasLive?{activePlayer:{level:15},gameData:{gameTime:900}}:null};
  const state=liveOverviewState(session,snapshot,historical);
  expect(state.mode).toBe(mode);
  expect(state.live).toBe(mode==='live');
  expect(state.data).toBe(mode==='live'?snapshot.liveData:session.liveData);
 });

 it.each(['Lobby','EndOfGame','ChampSelect','Disconnected','InProgress'])('keeps %s retained values clearly labeled and all current-choice controls hidden',phase=>{
  const session={...sessionFixture(),phase};
  const snapshot={...snapshotFixture(session),phase,liveData:phase==='EndOfGame'?session.liveData:null};
  const html=render(session,{snapshot,detectionMessage:'待选 OCR 提示不应继续显示'});
  expect(html).toContain(phase==='Disconnected'||phase==='InProgress'?'最近对局记录':'上一局记录');
  expect(html).toContain('记录等级</span><strong>Lv.8');
  expect(html).toContain('记录时长</span><strong>4:05');
  expect(html).toContain('历史候选记录');
  expect(html).toContain('只读记录 · 非当前选择');
  expect(html).toContain('循环往复');
  expect(html).toContain('已记录的本人海克斯：已确认海克斯');
  for(const staleText of ['aria-label="实时对局状态"','本轮模型推荐','候选已就绪','待模型分析','待选 OCR 提示不应继续显示','等待本轮海克斯候选','local-choice-controls','我选了「','补充 / 修改候选','配置模型分析'])expect(html).not.toContain(staleText);
 });

 it('does not call absent snapshots, a different game or a completed session live',()=>{
  const session=sessionFixture();
  expect(liveOverviewState(session,null,false).mode).toBe('unavailable');
  expect(liveOverviewState(session,{...snapshotFixture(session),gameId:'other-game'},false).mode).toBe('unavailable');
  expect(liveOverviewState({...session,endedAt:observedAt},snapshotFixture(session),false).mode).toBe('previous');
  expect(liveOverviewState(session,{...snapshotFixture(session),liveData:{}},false).mode).toBe('unavailable');
 });

 it('uses a fresh live snapshot for both displayed level and recommendation band',()=>{
  const session=sessionFixture();
  const snapshot={...snapshotFixture(session),liveData:{activePlayer:{level:11},gameData:{gameTime:700}}};
  const html=render(session,{snapshot});
  expect(html).toContain('当前等级</span><strong>Lv.11');
  expect(html).toContain('对局时间</span><strong>11:40');
  expect(html).toContain('等待第3轮的新候选');
  expect(html).not.toContain('本轮模型推荐');
  expect(html).not.toContain('我选了「');
 });

 it('shows historical values from the archive even when another live game is running',()=>{
  const session=sessionFixture();
  const snapshot={...snapshotFixture(session),gameId:'another-game',liveData:{activePlayer:{level:18},gameData:{gameTime:1500}}};
  const html=render(session,{snapshot,historical:true});
  expect(html).toContain('历史对局');
  expect(html).toContain('历史快照');
  expect(html).toContain('记录等级</span><strong>Lv.8');
  expect(html).toContain('记录时长</span><strong>4:05');
  expect(html).not.toContain('Lv.18');
  expect(html).not.toContain('候选已就绪');
  expect(html).not.toContain('补充 / 修改候选');
 });

 it('does not ask for another selection after the game when no candidates were captured',()=>{
  const session={...sessionFixture(),phase:'EndOfGame',candidates:newSession().candidates};
  const html=render(session,{snapshot:{...snapshotFixture(session),phase:'EndOfGame',liveData:null}});
  expect(html).toContain('本局未记录候选');
  expect(html).not.toContain('等待本轮海克斯候选');
  expect(html).not.toContain('游戏位于前台且出现候选面板时自动识别');
 });

 it('labels the first augment selection as round one while retaining the actual champion level',()=>{
  const session={...sessionFixture(),candidateBand:1,liveData:{activePlayer:{level:3},gameData:{gameTime:75}}};
  const html=render(session);
  expect(html).toContain('当前等级</span><strong>Lv.3');
  expect(html).toContain('第1轮 ·');
  expect(html).not.toContain('Lv.1');
 });
});
