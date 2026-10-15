import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {applySnapshot, hasContent, newSession} from '../src/domain.ts';
import {readSession} from '../src/sessionReader.ts';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, nextTriggers, ownLevel} from '../src/level.ts';
import {currentChoiceBand} from '../src/choiceContext.ts';
import {collectorPollDelay} from '../src/collectorCadence.ts';
import {OcrCadence,OCR_PANEL_GRACE_MS} from '../src/ocrCadence.ts';
import * as ocrFreshness from '../src/ocrContextFreshness.ts';
import {AutoRecommendationGate, autoRecommendationKey, AUTO_MAX_PER_ROUND} from '../src/autoRecommendation.ts';
import {CandidateScanBurst, CANDIDATE_RECHECK_MS} from '../src/candidateScanBurst.ts';
import {RecommendationProgress, recommendationProgressKey} from '../src/recommendationProgress.ts';
import {analysisDataIssue} from '../src/analysisPreflight.ts';
import {mergeDetectedCandidates} from '../src/candidates.ts';
import {createLocalRecommendation, localRecommendationKey, recognizedCandidates, selectLocalRecommendation} from '../src/liveRecommendation.ts';

// Extract production handlers without importing/mounting main.tsx. Every IPC is
// synthetic and allowlisted; these tests never capture screens or use a model.
const file = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map();
let detector;
const names = ['backgroundTick','poll','maybeAutoRecommend','confirmCandidateScan','cancelConfirmationScan','scheduleConfirmationScan'];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) handlers.set(node.name.text,node);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast)==='detectAugments') detector=node.initializer;
  ts.forEachChild(node,visit);
}
visit(ast);
if (handlers.size!==names.length || !detector) throw new Error('Actual OCR/cadence handlers not found');
const compile = text => ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const install = (context,...selected) => selected.forEach(name => vm.runInContext(compile(handlers.get(name).getText(ast)),context));
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}
const ref = current => ({current});
function playing() {
  return {...newSession(),id:'synthetic-session',matchId:'1234',phase:'InProgress',candidateBand:1,
    candidates:[1,2,3].map(id=>({id:String(id),name:`candidate ${id}`,description:`complete effect ${id}`,source:'ocr'})),
    liveData:{activePlayer:{level:3},gameData:{gameTime:30},events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}},players:[],ownPlayerId:''};
}
function snapshot(session,extra={}) {
  return {platformSupported:true,connection:'lcu-and-live',phase:session.phase,gameId:session.matchId,
    observedAt:new Date().toISOString(),liveData:session.liveData,lcuSession:null,endOfGame:null,result:null,warnings:[],...extra};
}
function harness() {
  const calls=[],errors=[],statuses=[],scans=[],collections=[];
  const session=playing();
  const context=vm.createContext({Date,Promise,setTimeout,clearTimeout,
    liveDetectionBand,currentChoiceBand,collectorPollDelay,applySnapshot,hasContent,readSession,augmentBand,nextTriggers,ownLevel,
    autoRecommendationKey,AUTO_MAX_PER_ROUND,...ocrFreshness,analysisDataIssue,
    recommendationProgressKey,CANDIDATE_RECHECK_MS,mergeDetectedCandidates,
    createLocalRecommendation,localRecommendationKey,recognizedCandidates,selectLocalRecommendation,
    current:ref(session),snapshotRef:ref(snapshot(session)),snapshotPollStartedAt:ref(Date.now()-100),openingOcrArmed:ref(''),
    config:ref({auto:true,historical:false,lockfile:''}),analysisSettings:ref({updating:false}),collectionPaused:ref(false),
    document:{hidden:true},epoch:ref(0),reading:ref(false),readingSince:ref(0),pollSeq:ref(0),nextPoll:ref(Date.now()+10_000),idleFailures:ref(0),
    scanning:ref(false),busyRef:ref(false),analysisTarget:ref(null),candidateRevision:ref(0),seenMatch:ref(session.id),seenIds:ref(''),panelMisses:ref(0),unconfirmedOverlay:ref(null),
    ocrCadence:ref(new OcrCadence()),autoRecommendationGate:ref(new AutoRecommendationGate()),candidateScanBurst:ref(new CandidateScanBurst()),
    lastAutoScan:ref(null),recommendationProgress:ref(new RecommendationProgress()),localRecommendationRef:ref(null),
    confirmationScan:ref(null),confirmScanRef:ref(vi.fn()),detectAugmentsRef:ref(vi.fn()),maybeAutoRecommendRef:ref(vi.fn()),runRef:ref(vi.fn()),
    isTauri:()=>true,poll:vi.fn(),automaticIssue:()=>'',automaticIssueCode:()=> 'synthetic',restoreDurableRecommendation:()=>null,
    reportRecommendation:(_session,status)=>statuses.push(status),setDetection:vi.fn(),setError:error=>errors.push(error),
    setLocalRecommendation:value=>{context.localRecommendationRef.current=value;},
    patch:patch=>{context.current.current={...context.current.current,...patch,updatedAt:new Date().toISOString()};},
    requestInterval:ref({remaining:()=>0}),knowledgeWarmup:ref({observe:vi.fn()}),postgameRetries:ref({observe:vi.fn()}),
    trigger:ref({matchId:'',fired:[]}),lastSaved:ref(Date.now()),setSnapshot:vi.fn(),save:vi.fn(async()=>{}),recoverPostgame:vi.fn(async()=>{}),
    commit:value=>{context.current.current=value;},
    invoke:async(command,args)=>{
      calls.push({command,args});
      if(command==='ocr_scan'){
        if(!scans.length)throw new Error('Missing synthetic OCR response');
        return scans.shift();
      }
      if(command==='collector_snapshot'){
        if(!collections.length)throw new Error('Missing synthetic collector response');
        return collections.shift();
      }
      if(command==='get_session_by_match')return null;
      if(['overlay_open','overlay_close','overlay_publish','overlay_analysis_status'].includes(command))return;
      throw new Error(`Unexpected IPC; actual app/API/model access forbidden: ${command}`);
    },
  });
  install(context,'backgroundTick','maybeAutoRecommend','cancelConfirmationScan','scheduleConfirmationScan','confirmCandidateScan');
  vm.runInContext(compile(`globalThis.detectAugments=${detector.getText(ast)}`),context);
  context.detectAugmentsRef.current=context.detectAugments;
  context.confirmScanRef.current=context.confirmCandidateScan;
  return {context,calls,errors,statuses,scans,collections,
    collectHandler:()=>install(context,'poll'),
    capture:async(extra={})=>{
      scans.push({source:'capture',candidates:context.current.current.candidates,elapsedMs:1,...extra});
      context.detectAugments(context.current.current);await flush();
    },
    scanned:()=>calls.filter(call=>call.command==='ocr_scan'),
    collected:()=>calls.filter(call=>call.command==='collector_snapshot'),
    advance:ms=>vi.setSystemTime(Date.now()+ms),
    fresh:()=>{context.snapshotRef.current=snapshot(context.current.current);},
  };
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('actual independent OCR scheduling',()=>{
  it('publishes recognized candidates before any model result, even with model analysis disabled',async()=>{
    const h=harness(),c=h.context;
    c.automaticIssue=()=> '模型分析已关闭';
    c.maybeAutoRecommendRef.current=vi.fn(c.maybeAutoRecommend);
    await h.capture();
    const publish=h.calls.find(call=>call.command==='overlay_publish');
    expect(publish?.args.payload.ranking.ranking.map(candidate=>candidate.id)).toEqual(['1','2','3']);
    expect(h.calls.filter(call=>call.command==='overlay_open')).toHaveLength(1);
    expect(h.statuses.at(-1)?.phase).toBe('blocked');
    expect(c.runRef.current).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });

  it('does not promote localization probes into candidates or paid analysis, even if a malformed response carries names',async()=>{
    const h=harness(),c=h.context;
    await h.capture({probeOnly:true,reason:'choice-region-unavailable'});
    expect(h.calls.filter(call=>['overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    expect(c.runRef.current).not.toHaveBeenCalled();expect(c.lastAutoScan.current).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it('uncertain localization revokes fresh-analysis evidence without declaring the visible panel gone',async()=>{
    const h=harness(),c=h.context;
    c.seenIds.current='previous-visible-group';
    c.lastAutoScan.current={key:autoRecommendationKey(c.current.current),at:Date.now()};
    for(let i=0;i<2;i++){
      await h.capture({source:'capture',probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
      h.advance(700);h.fresh();
    }
    expect(c.lastAutoScan.current).toBeNull();
    expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    expect(c.runRef.current).not.toHaveBeenCalled();
    // No new publication of old scores either: preservation != proof of freshness.
    expect(h.calls.filter(call=>['overlay_close','overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(c.panelMisses.current).toBe(0);
    expect(h.statuses.at(-1)?.code).toBe('choice-region-unavailable');
    expect(h.errors).toEqual([]);
  });

  it('preserves an in-flight request phase while unknown geometry revokes publication evidence',async()=>{
    const h=harness(),c=h.context;
    const target=c.current.current;
    c.busyRef.current=true;c.analysisTarget.current={snapshot:target};
    c.recommendationProgress.current.set(target,{phase:'analyzing',code:'request-dispatched',message:'已发出请求'});
    c.seenIds.current='visible-group';
    await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    expect(h.statuses.at(-1)).toMatchObject({phase:'analyzing',code:'choice-region-unavailable'});
    expect(c.analysisTarget.current.snapshot).toBe(target);expect(c.busyRef.current).toBe(true);
    expect(c.lastAutoScan.current).toBeNull();expect(c.panelMisses.current).toBe(0);
    expect(c.runRef.current).not.toHaveBeenCalled();expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    expect(h.calls.filter(call=>['overlay_close','overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('does not erase an actual model failure when geometry is uncertain',async()=>{
    const h=harness(),c=h.context,target=c.current.current;
    const failure={phase:'failed',code:'model-timeout',message:'模型请求超时'};
    c.recommendationProgress.current.set(target,failure);
    c.seenIds.current='visible-group';
    await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    expect(c.recommendationProgress.current.failure(target)).toBe(failure);
    expect(c.recommendationProgress.current.get(target)).toBe(failure);
    expect(h.statuses).toEqual([]);
    expect(h.calls.find(call=>call.command==='overlay_analysis_status')?.args.payload.analysis.code).toBe('choice-region-unavailable');
    expect(h.calls.filter(call=>['overlay_close','overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(c.lastAutoScan.current).toBeNull();expect(c.runRef.current).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('fresh same-group OCR clears only the uncertainty presentation without reopening or requesting a model',async()=>{
    const h=harness(),c=h.context;
    await h.capture();
    const waiting={phase:'waiting',code:'confirming-ocr',message:'正在复核候选'};
    c.recommendationProgress.current.set(c.current.current,waiting);
    h.calls.length=0;h.statuses.length=0;c.maybeAutoRecommendRef.current.mockClear();
    h.advance(700);h.fresh();
    await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    // Simulate the production status recorder, not a successful OCR observation.
    c.recommendationProgress.current.set(c.current.current,h.statuses.at(-1));
    h.advance(700);h.fresh();await h.capture();
    expect(h.statuses.at(-1)).toEqual(waiting);
    expect(h.calls.filter(call=>['overlay_close','overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(c.unconfirmedOverlay.current).toBeNull();
    expect(c.runRef.current).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });

  it('fresh OCR restores an actual failure to the sidebar even when the main progress never lost it',async()=>{
    const h=harness(),c=h.context;
    await h.capture();
    const failure={phase:'failed',code:'model-timeout',message:'模型请求超时'};
    c.recommendationProgress.current.set(c.current.current,failure);
    h.calls.length=0;
    h.advance(700);h.fresh();
    await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    h.advance(700);h.fresh();await h.capture();
    const updates=h.calls.filter(call=>call.command==='overlay_analysis_status');
    expect(updates.at(-1)?.args.payload.analysis).toEqual(failure);
    expect(c.recommendationProgress.current.failure(c.current.current)).toBe(failure);
    expect(c.unconfirmedOverlay.current).toBeNull();
    expect(c.runRef.current).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });

  it('restores an in-flight phase after real confirmation without restarting the model',async()=>{
    const h=harness(),c=h.context;
    await h.capture();
    const analyzing={phase:'analyzing',code:'request-dispatched',message:'请求已发出'};
    c.recommendationProgress.current.set(c.current.current,analyzing);
    c.busyRef.current=true;c.analysisTarget.current={snapshot:c.current.current};
    h.advance(700);h.fresh();await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    c.recommendationProgress.current.set(c.current.current,h.statuses.at(-1));
    h.advance(700);h.fresh();await h.capture();
    expect(h.statuses.at(-1)).toEqual(analyzing);
    expect(c.busyRef.current).toBe(true);expect(c.runRef.current).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('does not reuse uncertainty restoration across a new choice identity',async()=>{
    const h=harness(),c=h.context;
    await h.capture();
    const oldFailure={phase:'failed',code:'model-timeout',message:'上组失败'};
    c.recommendationProgress.current.set(c.current.current,oldFailure);
    h.advance(700);h.fresh();await h.capture({probeOnly:true,reason:'choice-region-unavailable',candidates:[]});
    const nextCards=[4,5,6].map(id=>({id:String(id),name:`new ${id}`,description:`effect ${id}`,source:'ocr'}));
    h.calls.length=0;h.statuses.length=0;
    h.advance(700);h.fresh();await h.capture({candidates:nextCards});
    expect(h.statuses).toEqual([]);
    expect(h.calls.filter(call=>call.command==='overlay_analysis_status')).toEqual([]);
    expect(h.calls.find(call=>call.command==='overlay_publish')?.args.payload.ranking.ranking.map(card=>card.id)).toEqual(['4','5','6']);
    expect(h.calls.filter(call=>call.command==='overlay_open')).toHaveLength(1);
    expect(c.unconfirmedOverlay.current).toBeNull();expect(h.errors).toEqual([]);
  });

  // Explicit optional bridge: REAL native replay JSON -> actual frontend handler.
  // IPC window/model effects remain allowlisted fakes, not a native UI/FPS test.
  const replayPath=process.env.HEXGLOW_OCR_REPLAY_OUTPUT;
  const replay=replayPath?JSON.parse(fs.readFileSync(replayPath,'utf8')):null;
  if(replay && (replay.schema!==1||replay.kind!=='native-screen-entry-replay'||!Array.isArray(replay.cases)))
    throw new Error('Invalid native screen-entry replay report');
  it.skipIf(!replay)('bridges actual native capture-mode responses to candidate publication and sidebar-open decisions',async()=>{
    const failures=[];
    for(const record of replay.cases){
      const h=harness(),c=h.context;
      c.current.current={...playing(),candidateBand:record.band,candidates:[],
        liveData:{...playing().liveData,activePlayer:{level:record.band===1?3:record.band}}};
      h.fresh();c.automaticIssue=()=> '模型分析已关闭';
      c.maybeAutoRecommendRef.current=vi.fn(c.maybeAutoRecommend);
      await h.capture(record.scan);
      expect(h.errors).toEqual([]);expect(c.runRef.current).not.toHaveBeenCalled();
      const published=h.calls.find(call=>call.command==='overlay_publish');
      const actual=published?.args.payload.ranking.ranking.map(candidate=>candidate.id)||[];
      const opened=h.calls.filter(call=>call.command==='overlay_open').length;
      if(JSON.stringify(actual)!==JSON.stringify(record.expectedIds)||opened!==(record.expectedIds.length>=2?1:0))
        failures.push({id:record.id,expectedIds:record.expectedIds,actualIds:actual,opened});
    }
    expect(failures,'Native screen responses that cannot reach a correct sidebar publication').toEqual([]);
  });

  it.skipIf(!replay?.cases.some(record=>record.id==='supplied-silver'))('replaces a candidate group using real replay responses without merging previous cards',async()=>{
    const sequence=['supplied-prismatic','supplied-silver'].map(id=>replay.cases.find(record=>record.id===id));
    expect(sequence.every(Boolean),'both explicit references are required').toBe(true);
    const h=harness(),c=h.context;
    c.current.current={...playing(),candidateBand:11,candidates:[],
      liveData:{...playing().liveData,activePlayer:{level:11}}};
    c.automaticIssue=()=> '模型分析已关闭';
    c.maybeAutoRecommendRef.current=vi.fn(c.maybeAutoRecommend);
    for(const record of sequence){
      h.fresh();await h.capture(record.scan);
      expect(c.current.current.candidates.map(candidate=>candidate.id)).toEqual(record.expectedIds);
      expect(h.calls.filter(call=>call.command==='overlay_publish').at(-1)?.args.payload.ranking.ranking.map(candidate=>candidate.id))
        .toEqual(record.expectedIds);
      expect(c.runRef.current).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
      h.advance(1000);
    }
    // This is a virtual refresh sequence, not a claim these two photos are one match.
    expect(h.calls.filter(call=>call.command==='overlay_open')).toHaveLength(2);
  });

  it('watches an already attempted group without treating unchanged title pixels as new recognition',async()=>{
    const h=harness(),c=h.context;
    c.autoRecommendationGate.current.markAttempt(c.current.current,true);
    c.seenIds.current='visible-group';c.lastAutoScan.current={key:autoRecommendationKey(c.current.current),at:Date.now()};
    await h.capture({probeOnly:true,unchangedPanel:true,watchCandidateIds:['1','2','3'],candidates:[]});
    expect(h.scanned()[0].args.watchCandidateIds).toEqual(['1','2','3']);
    expect(c.lastAutoScan.current).toBeNull();expect(c.panelMisses.current).toBe(0);
    expect(c.seenIds.current).toBe('visible-group');
    expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    expect(h.calls.filter(call=>['overlay_open','overlay_publish','overlay_close'].includes(call.command))).toEqual([]);
    expect(h.statuses).toEqual([]);expect(h.errors).toEqual([]);
  });

  it.each(['new-group','in-flight'])('never requests light title watching for %s',async mode=>{
    const h=harness(),c=h.context;
    if(mode==='in-flight'){c.autoRecommendationGate.current.markAttempt(c.current.current,true);c.busyRef.current=true;c.analysisTarget.current={};}
    await h.capture();
    expect(h.scanned()[0].args.watchCandidateIds).toBeNull();
  });

  it('rejects mismatched lightweight identities and requires real captures for a refreshed group',async()=>{
    const h=harness(),c=h.context;c.autoRecommendationGate.current.markAttempt(c.current.current,true);
    await h.capture({probeOnly:true,unchangedPanel:true,watchCandidateIds:['1','2','other'],candidates:[]});
    expect(c.panelMisses.current).toBe(1);
    expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    h.advance(500);h.fresh();
    const fresh=c.current.current.candidates.map((candidate,index)=>({...candidate,id:String(index+4)}));
    await h.capture({candidates:fresh});
    expect(c.current.current.candidates.map(candidate=>candidate.id)).toEqual(['4','5','6']);
    expect(h.calls.filter(call=>call.command==='overlay_open')).toHaveLength(1);
    h.advance(700);h.fresh();await h.capture();
    expect(h.scanned().at(-1).args.watchCandidateIds).toBeNull();
    expect(c.maybeAutoRecommendRef.current).toHaveBeenCalledTimes(2);
    expect(h.errors).toEqual([]);
  });

  it('rechecks engine readiness without publishing candidates, confirming a panel or calling a model',async()=>{
    const h=harness();
    // Defensive case: even a malformed warming response with retained cards is not evidence.
    await h.capture({waitingForReady:true,skipped:false,reason:'ocr-warming-up',elapsedMs:0});
    expect(h.context.lastAutoScan.current).toBeNull();
    expect(h.context.confirmationScan.current).toBeNull();
    expect(h.context.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    expect(h.calls.filter(call=>['overlay_open','overlay_publish'].includes(call.command))).toEqual([]);
    expect(h.statuses.at(-1).code).toBe('ocr-warming-up');
    h.advance(249);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(1);
    h.advance(1);h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(2);
    expect(h.context.maybeAutoRecommendRef.current).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
  });

  it('uses quarter-second ticks only as wakeups while both deadlines are pending',async()=>{
    const h=harness(),key=JSON.stringify([h.context.current.current.id,'1234',1]);
    const ticket=h.context.ocrCadence.current.begin(key,Date.now());
    h.context.ocrCadence.current.complete(ticket,{skipped:true,elapsedMs:1},Date.now());
    for(let i=0;i<7;i++){h.advance(250);h.context.backgroundTick();await flush();}
    expect(h.context.poll).not.toHaveBeenCalled();expect(h.scanned()).toHaveLength(0);
    expect(h.context.setDetection).not.toHaveBeenCalled();expect(h.statuses).toEqual([]);
  });

  it('scans eligible cards independently of a pending collector deadline, including while hidden',async()=>{
    const h=harness();h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});
    h.context.backgroundTick();await flush();
    expect(h.scanned()).toHaveLength(1);expect(h.context.poll).not.toHaveBeenCalled();
    h.advance(250);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(1);
    h.advance(100);h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(2);
  });

  it.each(['ChampSelect','GameStart','ReadyCheck','EndOfGame','None'])('does not scan retained candidates in %s',async phase=>{
    const h=harness();h.context.snapshotRef.current={...h.context.snapshotRef.current,phase};
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(0);
  });

  it.each(['auto-off','historical','paused','updating'])('does not schedule work while %s',async reason=>{
    const h=harness();h.context.nextPoll.current=0;
    if(reason==='auto-off')h.context.config.current.auto=false;
    if(reason==='historical')h.context.config.current.historical=true;
    if(reason==='paused')h.context.collectionPaused.current=true;
    if(reason==='updating')h.context.analysisSettings.current.updating=true;
    h.context.backgroundTick();await flush();expect(h.context.poll).not.toHaveBeenCalled();expect(h.scanned()).toHaveLength(0);
  });

  it.each(['old','future','missing','disconnected'])('does not independently scan with a %s snapshot',async reason=>{
    const h=harness(),snap=h.context.snapshotRef.current;
    if(reason==='old')snap.observedAt=new Date(Date.now()-5001).toISOString();
    if(reason==='future')snap.observedAt=new Date(Date.now()+1).toISOString();
    if(reason==='missing')snap.observedAt='';
    if(reason==='disconnected')snap.connection='disconnected';
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(0);
  });

  it.each(['direct','confirmation-timer','confirmation-tick'])('does not bypass snapshot expiry through %s',async route=>{
    const h=harness(),c=h.context;
    c.candidateScanBurst.current.arm(autoRecommendationKey(c.current.current),Date.now());
    c.scheduleConfirmationScan(c.current.current);
    h.advance(CANDIDATE_RECHECK_MS);
    c.snapshotRef.current.observedAt=new Date(Date.now()-5001).toISOString();
    if(route==='direct')c.detectAugments(c.current.current);
    if(route==='confirmation-timer')c.confirmCandidateScan();
    if(route==='confirmation-tick')c.backgroundTick();
    await flush();expect(h.scanned()).toHaveLength(0);
    expect(c.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
  });

  it('keeps OCR single-flight even when native tick and poll both request it',async()=>{
    const h=harness(),pending=deferred();h.scans.push(pending.promise);
    h.context.backgroundTick();h.context.detectAugments(h.context.current.current);await flush();
    h.advance(1000);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(1);
    expect(h.context.scanning.current).toBe(true);
    pending.resolve({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1000});await flush();
    expect(h.context.scanning.current).toBe(false);
  });

  it('does not use retained cards as evidence of a visible panel after a foreground skip',async()=>{
    const h=harness();await h.capture({skipped:true,candidates:[]});
    for(let i=0;i<7;i++){h.advance(250);h.context.backgroundTick();await flush();}
    expect(h.scanned()).toHaveLength(1);expect(h.context.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
    h.advance(250);h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(2);
  });

  it('backs off repeated empty panels even when a full previous group is retained',async()=>{
    const h=harness();await h.capture({candidates:[]});
    h.advance(699);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(1);
    h.advance(1);await h.capture({candidates:[]});expect(h.scanned()).toHaveLength(2);
    h.advance(1999);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(2);
    h.advance(1);await h.capture({candidates:[]});expect(h.scanned()).toHaveLength(3);
    expect(h.context.current.current.candidates).toHaveLength(3);
    expect(h.context.maybeAutoRecommendRef.current).not.toHaveBeenCalled();
  });

  it('bounds confirmation of a slow complete panel while honoring single-flight and the idle deadline',async()=>{
    const h=harness();await h.capture({elapsedMs:900});
    h.context.candidateScanBurst.current.arm(autoRecommendationKey(h.context.current.current),Date.now());
    h.context.scheduleConfirmationScan(h.context.current.current);
    h.advance(CANDIDATE_RECHECK_MS);h.context.confirmCandidateScan();
    expect(h.scanned()).toHaveLength(1);expect(h.context.confirmationScan.current.at-Date.now()).toBe(700-CANDIDATE_RECHECK_MS);
    h.advance(700-CANDIDATE_RECHECK_MS-1);h.context.confirmCandidateScan();expect(h.scanned()).toHaveLength(1);
    h.advance(1);h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});
    h.context.confirmCandidateScan();await flush();expect(h.scanned()).toHaveLength(2);
  });

  it('keeps a real missed confirmation in the short panel grace without treating retained candidates as an observation',async()=>{
    const h=harness(),pending=deferred();await h.capture({elapsedMs:716});
    h.advance(700);h.scans.push(pending.promise);
    h.context.detectAugments(h.context.current.current);await flush();
    h.advance(3277);pending.resolve({source:'capture',candidates:[],elapsedMs:3277});await flush();
    const key=JSON.stringify([h.context.current.current.id,h.context.current.current.matchId,1]);
    expect(h.context.ocrCadence.current.remaining(key,Date.now())).toBe(700);
    expect(h.context.maybeAutoRecommendRef.current).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toMatchObject({phase:'waiting',code:'incomplete-ocr'});
    expect(h.context.autoRecommendationGate.current.firstObservedAt(h.context.current.current)).toBeNull();
    h.advance(699);h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(2);
    h.advance(1);h.fresh();h.scans.push({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:250});
    h.context.backgroundTick();await flush();expect(h.scanned()).toHaveLength(3);
    expect(h.context.maybeAutoRecommendRef.current).toHaveBeenCalledTimes(2);
  });

  it('discards an OCR result whose epoch changed, without publishing or analyzing it',async()=>{
    const h=harness(),pending=deferred();h.scans.push(pending.promise);
    h.context.detectAugments(h.context.current.current);h.context.epoch.current++;
    pending.resolve({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:1});await flush();
    expect(h.calls.filter(call=>call.command==='overlay_publish'||call.command==='overlay_open')).toEqual([]);
    expect(h.context.maybeAutoRecommendRef.current).not.toHaveBeenCalled();expect(h.context.scanning.current).toBe(false);
  });

  it('does not publish an OCR response after its collector evidence expires in flight',async()=>{
    const h=harness(),pending=deferred();h.scans.push(pending.promise);
    h.context.detectAugments(h.context.current.current);h.advance(5001);
    pending.resolve({source:'capture',candidates:h.context.current.current.candidates,elapsedMs:5001});await flush();
    expect(h.calls.filter(call=>call.command==='overlay_publish'||call.command==='overlay_open')).toEqual([]);
    expect(h.context.maybeAutoRecommendRef.current).not.toHaveBeenCalled();expect(h.context.scanning.current).toBe(false);
  });
});

describe('actual collector start binding and automatic payment guard',()=>{
  it.each([7,11,15])('a fresh level %s signal immediately scans the new stage rather than inheriting combat backoff',async level=>{
    const h=harness(),c=h.context,key=JSON.stringify([c.current.current.id,c.current.current.matchId,1]);
    let ticket=c.ocrCadence.current.begin(key,Date.now());
    c.ocrCadence.current.complete(ticket,{matched:3},Date.now());
    h.advance(OCR_PANEL_GRACE_MS+1);
    ticket=c.ocrCadence.current.begin(key,Date.now());
    c.ocrCadence.current.complete(ticket,{matched:0,elapsedMs:5000},Date.now());
    expect(c.ocrCadence.current.remaining(key,Date.now())).toBe(15000);
    h.collectHandler();
    h.collections.push(snapshot(c.current.current,{liveData:{activePlayer:{level},gameData:{gameTime:300}}}));
    h.scans.push({source:'capture',candidates:c.current.current.candidates,elapsedMs:1});
    await c.poll();await flush();
    expect(h.scanned()).toHaveLength(1);
    expect(c.current.current.candidateBand).toBe(level);
    expect(h.calls.find(call=>call.command==='overlay_open')?.args).toEqual({level});
    expect(h.errors).toEqual([]);
  });

  it('arms the opening once on a real API event, without resetting on every poll',async()=>{
    const h=harness(),c=h.context,key=JSON.stringify([c.current.current.id,c.current.current.matchId,1]);
    c.current.current.liveData=null;
    c.current.current.timeline=[{at:new Date(Date.now()-1000).toISOString(),phase:'GameStart',connection:'lcu'},{at:new Date().toISOString(),phase:'InProgress',connection:'lcu'}];
    const miss=c.ocrCadence.current.begin(key,Date.now());
    c.ocrCadence.current.complete(miss,{matched:0,elapsedMs:1},Date.now());
    expect(c.ocrCadence.current.isDue(key,Date.now())).toBe(false);
    h.collectHandler();c.detectAugments=vi.fn();
    h.collections.push(snapshot(c.current.current,{liveData:{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}}}));
    await c.poll();await flush();
    expect(c.ocrCadence.current.isDue(key,Date.now())).toBe(true);
    const next=c.ocrCadence.current.begin(key,Date.now());
    c.ocrCadence.current.complete(next,{matched:0,elapsedMs:1},Date.now());
    h.collections.push(snapshot(c.current.current,{liveData:{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}}}));
    await c.poll();await flush();
    expect(c.ocrCadence.current.remaining(key,Date.now())).toBe(700);
    expect(h.errors).toEqual([]);
  });

  it('binds only the completed, accepted snapshot to its own request start time',async()=>{
    const h=harness(),pending=deferred(),old=h.context.snapshotRef.current,oldStart=h.context.snapshotPollStartedAt.current;
    h.collectHandler();h.context.detectAugments=vi.fn();h.collections.push(pending.promise);
    const started=Date.now(),task=h.context.poll();h.advance(1500);
    expect(h.context.snapshotRef.current).toBe(old);expect(h.context.snapshotPollStartedAt.current).toBe(oldStart);
    const next=snapshot(h.context.current.current);pending.resolve(next);await task;await flush();
    expect(h.context.snapshotRef.current).toBe(next);expect(h.context.snapshotPollStartedAt.current).toBe(started);
    expect(Date.parse(next.observedAt)).toBe(started+1500);expect(h.errors).toEqual([]);
  });

  it('does not let a timed-out older request overwrite a newer snapshot or its start',async()=>{
    const h=harness(),old=deferred(),next=deferred();h.collectHandler();h.context.detectAugments=vi.fn();
    h.collections.push(old.promise,next.promise);const taskOld=h.context.poll();h.advance(30_001);
    const newStart=Date.now(),taskNew=h.context.poll(),accepted=snapshot(h.context.current.current);
    next.resolve(accepted);await taskNew;await flush();old.resolve(snapshot(h.context.current.current,{phase:'None'}));await taskOld;await flush();
    expect(h.context.snapshotRef.current).toBe(accepted);expect(h.context.snapshotPollStartedAt.current).toBe(newStart);
    expect(h.context.reading.current).toBe(false);expect(h.collected()).toHaveLength(2);
  });

  it.each([0,5])('retains bounded collector error backoff with %s previous failures, not quarter-second retries',async failures=>{
    const h=harness();h.collectHandler();h.context.idleFailures.current=failures;h.context.snapshotRef.current=null;h.context.nextPoll.current=0;
    h.collections.push(Promise.reject(new Error('synthetic unavailable')));await h.context.poll();
    const delay=failures===0?8000:15000;
    expect(h.context.nextPoll.current-Date.now()).toBe(delay);
    for(let i=0;i<7;i++){h.advance(250);h.context.backgroundTick();await flush();}
    expect(h.collected()).toHaveLength(1);expect(h.errors).toHaveLength(1);
  });

  it('does not let a rejected timed-out request delay a newer successful collector result',async()=>{
    const h=harness(),old=deferred();h.collectHandler();h.context.detectAugments=vi.fn();h.collections.push(old.promise);
    const oldTask=h.context.poll();h.advance(30_001);h.collections.push(snapshot(h.context.current.current));await h.context.poll();
    const next=h.context.nextPoll.current,failures=h.context.idleFailures.current;
    old.reject(new Error('synthetic late rejection'));await oldTask;
    expect(h.context.nextPoll.current).toBe(next);expect(h.context.idleFailures.current).toBe(failures);
    expect(h.errors).toEqual([]);expect(h.context.reading.current).toBe(false);
  });

  it('requires an additional collector request begun after OCR, not an old request completed after OCR',()=>{
    const h=harness(),c=h.context,firstAt=Date.now(),scan={source:'capture',candidates:c.current.current.candidates};
    c.maybeAutoRecommend(c.current.current,scan);expect(c.nextPoll.current).toBe(0);
    c.nextPoll.current=Date.now()+10_000;h.advance(500);
    c.snapshotPollStartedAt.current=firstAt-1;h.fresh();c.maybeAutoRecommend(c.current.current,scan);
    expect(c.runRef.current).not.toHaveBeenCalled();expect(h.statuses.at(-1).code).toBe('refreshing-context');
    expect(c.nextPoll.current).toBe(firstAt+10_000); // Repeated OCR does not continuously force API polling.
    c.snapshotPollStartedAt.current=firstAt+1;c.maybeAutoRecommend(c.current.current,scan);
    expect(c.runRef.current).toHaveBeenCalledExactlyOnceWith('recommend',c.current.current,true);
  });

  it('does not analyze new cards interpreted under a retained old band',()=>{
    const h=harness(),c=h.context,scan={source:'capture',candidates:c.current.current.candidates};
    const firstAt=Date.now();c.maybeAutoRecommend(c.current.current,scan);h.advance(500);
    c.snapshotPollStartedAt.current=firstAt+1;
    c.snapshotRef.current=snapshot(c.current.current,{liveData:{activePlayer:{level:7},gameData:{gameTime:300}}});
    c.maybeAutoRecommend(c.current.current,scan);
    expect(c.runRef.current).not.toHaveBeenCalled();expect(h.statuses.at(-1).code).toBe('round-changed');
    expect(c.autoRecommendationGate.current.firstObservedAt(c.current.current)).toBeNull();
  });

  it('still requires two actual captures even if current collector evidence is fresh',()=>{
    const h=harness(),c=h.context,firstAt=Date.now(),scan={source:'capture',candidates:c.current.current.candidates};
    c.maybeAutoRecommend(c.current.current,scan);h.advance(500);c.snapshotPollStartedAt.current=firstAt+1;h.fresh();
    // A tick with both free-work deadlines deferred cannot replay retained OCR into a payment.
    c.nextPoll.current=Date.now()+1000;c.detectAugmentsRef.current=vi.fn();c.confirmScanRef.current=vi.fn();c.backgroundTick();
    expect(c.runRef.current).not.toHaveBeenCalled();expect(c.autoRecommendationGate.current.isReady(c.current.current,Date.now())).toBe(false);
    c.maybeAutoRecommend(c.current.current,scan);expect(c.runRef.current).toHaveBeenCalledTimes(1);
  });

  it('does not pay for a new group while another analysis is busy, and requests only one context refresh',()=>{
    const h=harness(),c=h.context;c.busyRef.current=true;c.analysisTarget.current={snapshot:c.current.current};
    const scan={source:'capture',candidates:c.current.current.candidates};c.maybeAutoRecommend(c.current.current,scan);
    expect(c.nextPoll.current).toBe(0);c.nextPoll.current=Date.now()+1000;h.advance(500);c.maybeAutoRecommend(c.current.current,scan);
    expect(c.nextPoll.current-Date.now()).toBe(500);expect(c.runRef.current).not.toHaveBeenCalled();
  });
});
