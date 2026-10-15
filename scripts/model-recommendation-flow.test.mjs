import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {newSession, hasContent, synchronizeSelections, blockers} from '../src/domain.ts';
import {AnalysisTarget} from '../src/analysis.ts';
import {analysisSource} from '../src/analysisGate.ts';
import {RequestInterval, NEW_REQUEST_INTERVAL_MS, REPEAT_REQUEST_INTERVAL_MS} from '../src/requestInterval.ts';
import {liveOverviewState} from '../src/LiveOverview.tsx';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, ownLevel} from '../src/level.ts';
import {markCandidateEdits, mergeDetectedCandidates} from '../src/candidates.ts';
import {SaveQueue} from '../src/saveQueue.ts';
import {createLocalRecommendation, localRecommendationKey, recognizedCandidates, modelRecommendation, selectLocalRecommendation,restoreModelRecommendation} from '../src/liveRecommendation.ts';
import {canRetainModelRecommendation,canPublishModelRecommendation, modelContextKey} from '../src/modelPublication.ts';
import {AUTO_MAX_PER_ROUND,AUTO_STABLE_MS, AutoRecommendationGate, autoRecommendationKey} from '../src/autoRecommendation.ts';
import {OcrCadence,OCR_FIRST_MISS_IDLE_MS} from '../src/ocrCadence.ts';
import {canAnalyzeObservedChoice,hasFreshOcrSnapshot} from '../src/ocrContextFreshness.ts';
import {CandidateScanBurst, CANDIDATE_RECHECK_MS, CANDIDATE_BURST_WINDOW_MS} from '../src/candidateScanBurst.ts';
import {autoModelIdentity, automaticModelIssue} from '../src/autoModelConfig.ts';
import {RecommendationProgress,recommendationProgressKey} from '../src/recommendationProgress.ts';
import {analysisDataIssue,analysisFailure} from '../src/analysisPreflight.ts';

// Run the actual application handlers with synthetic state/IPC only. Importing
// main.tsx would mount the desktop app and is intentionally never done here.
const file = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let detector, restored, knowledgeChanged, setAuto;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['run','patch','save','writeSnapshot','automaticIssue','maybeAutoRecommend','resumeLive','reportRecommendation','cancelConfirmationScan','scheduleConfirmationScan','confirmCandidateScan','automaticIssueCode','restoreDurableRecommendation'].includes(node.name?.text)) callbacks.set(node.name.text,node);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'detectAugments') detector = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'setAuto') setAuto = node.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements.some(element => element.getText(ast) === 'localScoreKey')) restored = node.arguments[0];
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'KnowledgePanel') knowledgeChanged = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onChanged')?.initializer?.expression;
  ts.forEachChild(node,visit);
}
visit(ast);
if (callbacks.size !== 13 || !detector || !restored || !knowledgeChanged || !setAuto) throw new Error('Actual model/recognition application handlers not found');
const compile = text => ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function flush(){for(let n=0;n<40;n++)await Promise.resolve();}

function playing(){
  return {...newSession(),id:'synthetic-session',matchId:'1234',phase:'InProgress',candidateBand:1,ownPlayerId:'synthetic#1',
    players:[{id:'synthetic#1',name:'synthetic',champion:'Ekko',team:'ORDER',items:[],augments:[],augmentsConfirmed:true},
      {id:'synthetic#2',name:'synthetic opponent',champion:'Lux',team:'CHAOS',items:[],augments:[],augmentsConfirmed:true}],
    candidates:[1,2,3].map(id=>({id:String(id),name:`candidate ${id}`,description:`complete effect ${id}`,source:'ocr'})),
    liveData:{activePlayer:{riotId:'synthetic#1',level:3},gameData:{gameTime:70},allPlayers:[],events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}}};
}
function modelResult(session){return {summary:'synthetic model comparison',missingInformation:[],
  engine:{provider:'mock',model:'offline-only',latencyMs:1,confidenceKind:'model',scoringMode:'dynamic-model-v1'},
  ranking:session.candidates.map((candidate,index)=>({candidateId:candidate.id,score:80-index*10,confidence:0.8,reason:'synthetic reason',evidence:['synthetic source'],risks:[]}))};}

function harness({session=playing(),saveGate=null,retrievalGate=null,publicationGate=null,autoRecommend=false,consent=true,dailyLimit=20,used=0,provider='openai',historyEntries=[],autoCollector=true}={}){
  const calls=[],errors=[],writes=[],trace=[],analyses=[],scans=[];
  const model={provider,name:'offline-only',baseUrl:provider==='jev'?'https://api.typesafe.ai':'https://api.openai.com/v1'};
  const analysisSettings={current:{model,apiKey:'not-a-real-key',consent,autoRecommend,dailyLimit,revision:0,updating:false}};
  const context=vm.createContext({Date,Promise,structuredClone,setTimeout,clearTimeout,
    AnalysisTarget,analysisSource,liveOverviewState,liveDetectionBand,augmentBand,ownLevel,
    markCandidateEdits,mergeDetectedCandidates,synchronizeSelections,hasContent,blockers,
    createLocalRecommendation,localRecommendationKey,recognizedCandidates,modelRecommendation,selectLocalRecommendation,restoreModelRecommendation,
    canRetainModelRecommendation,canPublishModelRecommendation,modelContextKey,AutoRecommendationGate,autoRecommendationKey,autoModelIdentity,automaticModelIssue,
    recommendationProgressKey,analysisDataIssue,analysisFailure,AUTO_MAX_PER_ROUND,AUTO_STABLE_MS,CandidateScanBurst,CANDIDATE_RECHECK_MS,canAnalyzeObservedChoice,hasFreshOcrSnapshot,
    ocrCadence:{current:new OcrCadence()},nextPoll:{current:0},snapshotPollStartedAt:{current:Date.now()-1},
    candidateScanBurst:{current:new CandidateScanBurst()},
    recommendationProgress:{current:new RecommendationProgress()},confirmationScan:{current:null},confirmScanRef:{current:null},detectAugmentsRef:{current:null},
    current:{current:session},session,snapshotRef:{current:{connection:'connected',phase:'InProgress',gameId:session.matchId,liveData:session.liveData,observedAt:new Date().toISOString()}},
    config:{current:{historical:false,view:'live',auto:true}},historical:false,epoch:{current:0},busyRef:{current:false},collectionPaused:{current:false},
    analysisTarget:{current:null},activeSession:{current:null},knowledgeRevision:{current:0},requestInterval:{current:new RequestInterval(()=>Date.now())},dailyLimit,
    consent,autoRecommend,model,apiKey:'not-a-real-key',analysisSettings,modelKeys:{current:null},
    autoRecommendationGate:{current:new AutoRecommendationGate()},lastAutoScan:{current:null},runRef:{current:null},maybeAutoRecommendRef:{current:null},
    scanning:{current:false},seenMatch:{current:session.id},seenIds:{current:''},candidateRevision:{current:0},panelMisses:{current:0},unconfirmedOverlay:{current:null},
    debounce:{current:null},writeQueue:{current:Promise.resolve()},lastSaved:{current:0},
    localRecommendation:null,localRecommendationRef:{current:null},
    isTauri:()=>true,readUsage:()=>({count:used}),bumpUsage:vi.fn(()=>++used),modelServiceLabel:()=> 'offline test',setAutoRecommendStatus:vi.fn(),
    setView:vi.fn(),setBusy:vi.fn(),setDailyUsed:vi.fn(),setFlash:vi.fn(),setSaved:vi.fn(),setKnowledge:vi.fn(),setSimilar:vi.fn(),setDetection:vi.fn(),refreshHistory:async()=>[],setAutoState:vi.fn(),setHistorical:vi.fn(),poll:vi.fn(),
    setError:error=>{if(error)errors.push(error);},setArchiveDetail:vi.fn(),
    setLocalRecommendation:value=>{const next=typeof value==='function'?value(context.localRecommendation):value;context.localRecommendation=next;context.localRecommendationRef.current=next;trace.push(['local',next?.result.source]);},
    commit:value=>{const next=synchronizeSelections(value);context.analysisTarget.current?.observe(next);context.current.current=next;context.session=next;},
    invoke:async(command,args)=>{
      calls.push({command,args});
      if(command==='knowledge_retrieve'){if(retrievalGate)await retrievalGate.promise;return {documents:[],missing:[],warnings:[],fingerprint:'synthetic-knowledge'};}
      if(command==='history_similarity')return historyEntries;
      if(command==='analyze_structured'){const request=deferred();analyses.push({...request,args});return request.promise;}
      if(command==='save_session'){trace.push(['save-start']);if(saveGate){const pending=saveGate;saveGate=null;await pending.promise;}writes.push(structuredClone(args.session));trace.push(['save-durable']);return;}
      if(command==='ocr_scan'){if(!scans.length)throw new Error('Missing synthetic OCR scan');return scans.shift();}
      if(command==='overlay_analysis_status'||command==='recommendation_diagnostic')return;
      if(command==='overlay_publish'){trace.push(['publish',args.payload.ranking.source]);if(publicationGate&&args.payload.ranking.source==='model')await publicationGate.promise;return;}
      if(command==='overlay_open'||command==='overlay_close'){trace.push([command]);return;}
      throw new Error(`Unexpected IPC (no real API is allowed): ${command}`);
    },
  });
  for(const callback of callbacks.values())vm.runInContext(compile(callback.getText(ast)),context);
  context.saver={current:new SaveQueue(context.writeSnapshot)};
  context.runRef.current=context.run;context.maybeAutoRecommendRef.current=context.maybeAutoRecommend;
  vm.runInContext(compile(`globalThis.detectAugments=${detector.getText(ast)};globalThis.restored=${restored.getText(ast)};globalThis.knowledgeChanged=${knowledgeChanged.getText(ast)};globalThis.setAuto=${setAuto.getText(ast)};`),context);
  const syncCollector=()=>{if(autoCollector&&context.snapshotRef.current){context.snapshotPollStartedAt.current=Date.now()-1;context.snapshotRef.current={...context.snapshotRef.current,observedAt:new Date().toISOString()};}};
  context.detectAugmentsRef.current=context.detectAugments;context.confirmScanRef.current=()=>{syncCollector();context.confirmCandidateScan();};
  return {context,calls,errors,writes,trace,analyses,scans,syncCollector,
    publications:()=>calls.filter(call=>call.command==='overlay_publish'),
    // Each explicit scan represents a new allowed capture plus a completed API
    // observation, as in the original poll-driven fixture. Separate tests opt
    // out of autoCollector to verify independently scheduled/stale observations.
    scan:async(candidates=context.current.current.candidates,extra={})=>{const active=context.current.current;const band=liveDetectionBand(active,context.snapshotRef.current,false);if(band!==null){const wait=context.ocrCadence.current.remaining(JSON.stringify([active.id,active.matchId,band]),Date.now());if(Number.isFinite(wait)&&wait>0)vi.setSystemTime(Date.now()+wait);}syncCollector();scans.push({candidates,source:'capture',elapsedMs:1,model:'offline',...extra});context.detectAugments(context.current.current);await flush();},
    settings:patch=>{analysisSettings.current={...analysisSettings.current,...patch,revision:analysisSettings.current.revision+1};},
    advance:ms=>{vi.setSystemTime(Date.now()+ms);},
    cacheModel:()=>context.setLocalRecommendation(createLocalRecommendation(context.current.current,modelRecommendation(context.current.current,modelResult(context.current.current)))),
  };
}

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('actual application model recommendation flow',()=>{
  it.each(['manual-recommend','automatic-recommend','review'])('does not retrieve or attach cross-game history for Jev %s',async route=>{
    const session=route==='review'?{...playing(),phase:'EndOfGame',archived:true,endedAt:new Date().toISOString()}:playing();
    const historyEntries=[{id:'unrelated-history',ownChampion:'Lux',outcome:'synthetic past result'}];
    const h=harness({session,provider:'jev',historyEntries,autoRecommend:route==='automatic-recommend'});
    let task;
    if(route==='automatic-recommend'){await h.scan();h.advance(AUTO_STABLE_MS);await h.scan();}
    else {task=h.context.run(route==='review'?'review':'recommend');await flush();}
    expect(h.analyses).toHaveLength(1);
    expect(h.calls.filter(call=>call.command==='history_similarity')).toHaveLength(0);
    expect(h.calls.filter(call=>call.command==='knowledge_retrieve')).toHaveLength(1);
    expect(h.analyses[0].args.request.context).not.toHaveProperty('history');
    expect(h.analyses[0].args.request.context).toHaveProperty('knowledge');
    // The local session identity still locates the current hero; backend projection
    // removes identifiers from the outbound Jev state, not from persisted sessions.
    expect(h.analyses[0].args.request.context.ownPlayerId).toBe(session.ownPlayerId);
    expect(h.context.setSimilar).toHaveBeenLastCalledWith([]);
    h.analyses[0].resolve(route==='review'?{summary:'synthetic review',lessons:[],caveats:[]}:modelResult(session));
    await task;await flush();
    expect(h.errors).toEqual([]);expect(h.writes).toHaveLength(1);
    expect(h.writes[0].ownPlayerId).toBe(session.ownPlayerId);
  });

  it.each(['manual-recommend','automatic-recommend','review'])('preserves history retrieval and context for OpenAI %s',async route=>{
    const session=route==='review'?{...playing(),phase:'EndOfGame',archived:true,endedAt:new Date().toISOString()}:playing();
    const historyEntries=[{id:'related-history',ownChampion:'Ekko',outcome:'synthetic past result'}];
    const h=harness({session,provider:'openai',historyEntries,autoRecommend:route==='automatic-recommend'});
    let task;
    if(route==='automatic-recommend'){await h.scan();h.advance(AUTO_STABLE_MS);await h.scan();}
    else {task=h.context.run(route==='review'?'review':'recommend');await flush();}
    expect(h.analyses).toHaveLength(1);
    const retrievals=h.calls.filter(call=>call.command==='history_similarity');
    expect(retrievals).toHaveLength(1);expect(retrievals[0].args.limit).toBe(5);
    expect(h.analyses[0].args.request.context.history).toEqual(historyEntries);
    expect(h.context.setSimilar).toHaveBeenLastCalledWith(historyEntries);
    h.analyses[0].resolve(route==='review'?{summary:'synthetic review',lessons:[],caveats:[]}:modelResult(session));
    await task;await flush();
    expect(h.errors).toEqual([]);expect(h.writes).toHaveLength(1);
  });

  it('waits for credential restoration before sending manual analysis',async()=>{
    const h=harness();h.context.modelKeys.current={isLoading:()=>true};
    await h.context.run('recommend');expect(h.analyses).toHaveLength(0);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();expect(h.errors.at(-1)).toContain('正在恢复');
  });

  it('does not send automatic analysis while saved credentials are loading',async()=>{
    const h=harness({autoRecommend:true});h.context.modelKeys.current={isLoading:()=>true};
    await h.scan();h.advance(1200);await h.scan();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.setAutoRecommendStatus).toHaveBeenLastCalledWith(expect.stringContaining('正在恢复'));
  });
  it('OCR and restored candidates never invoke local scoring or a paid model',async()=>{
    for(const route of ['ocr','restored']){
      const h=harness();
      if(route==='ocr')await h.scan();else {h.context.restored();await flush();}
      expect(h.errors).toEqual([]);
      expect(h.calls.some(call=>['score_candidates','analyze_structured'].includes(call.command))).toBe(false);
      expect(h.publications()).toHaveLength(1);
      expect(h.publications()[0].args.payload.ranking.source).toBe('recognition');
    }
  });

  it('issues one paid call per run and publishes the model only after durable save',async()=>{
    const gate=deferred(),h=harness({saveGate:gate});
    const task=h.context.run('recommend');await flush();
    expect(h.analyses).toHaveLength(1);
    h.analyses[0].resolve(modelResult(h.context.current.current));await flush();
    expect(h.trace).toContainEqual(['save-start']);expect(h.publications()).toHaveLength(0);
    gate.resolve();await task;
    expect(h.errors).toEqual([]);expect(h.writes).toHaveLength(1);
    expect(h.publications()).toHaveLength(1);
    expect(h.trace.findIndex(event=>event[0]==='save-durable')).toBeLessThan(h.trace.findIndex(event=>event[0]==='publish'));
    expect(h.calls.filter(call=>call.command==='analyze_structured')).toHaveLength(1);
    expect(h.calls.some(call=>call.command==='score_candidates')).toBe(false);
    expect(h.trace.findIndex(event=>event[0]==='publish')).toBeLessThan(h.trace.findIndex(event=>event[0]==='overlay_open'));
  });

  it('does not publish if result persistence fails',async()=>{
    const gate=deferred(),h=harness({saveGate:gate});
    const task=h.context.run('recommend');await flush();h.analyses[0].resolve(modelResult(h.context.current.current));await flush();
    gate.reject(new Error('synthetic disk unavailable'));await task;
    expect(h.publications()).toHaveLength(0);expect(h.errors.some(e=>e.includes('保存或显示失败'))).toBe(true);
    expect(h.analyses).toHaveLength(1);
  });

  it.each(['items','candidates','next-game','knowledge'])('archives an in-flight result without publishing after %s changes',async change=>{
    const h=harness(),original=h.context.current.current;
    const task=h.context.run('recommend');await flush();
    if(change==='items')h.context.commit({...original,players:original.players.map(p=>({...p,items:[{itemID:3115}]}))});
    if(change==='candidates')h.context.commit({...original,candidates:original.candidates.map((c,i)=>i?c:{...c,description:'updated full effect',source:'manual'})});
    if(change==='next-game')h.context.commit({...playing(),id:'next-session',matchId:'5678'});
    if(change==='knowledge')h.context.knowledgeChanged();
    h.analyses[0].resolve(modelResult(original));await task;
    expect(h.analyses).toHaveLength(1);expect(h.writes).toHaveLength(1);expect(h.publications()).toHaveLength(change==='items'?1:0);
    if(change==='items')expect(h.publications()[0].args.payload.ranking.contextChanged).toBe(true);
    expect(h.writes[0].decisions).toHaveLength(1);
    expect(h.writes[0].decisions[0].context.id).toBe(original.id);
    if(change==='next-game')expect(h.context.current.current.id).toBe('next-session');
    if(change==='items')expect(h.writes[0].players[0].items).toEqual([{itemID:3115}]);
  });

  it('rechecks context before billing if candidates change during knowledge retrieval',async()=>{
    const gate=deferred(),h=harness({retrievalGate:gate});
    const task=h.context.run('recommend');await flush();
    h.context.commit({...h.context.current.current,notes:'changed while retrieving'});
    gate.resolve();await task;
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors.some(e=>e.includes('尚未调用模型'))).toBe(true);
  });

  it('does not bill after losing the live snapshot during knowledge retrieval',async()=>{
    const gate=deferred(),h=harness({retrievalGate:gate});
    const task=h.context.run('recommend');await flush();
    h.context.snapshotRef.current={connection:'disconnected',phase:'InProgress',gameId:'1234',liveData:null};
    gate.resolve();await task;
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.publications()).toHaveLength(0);
  });

  it('rechecks current context after waiting for save durability',async()=>{
    const gate=deferred(),h=harness({saveGate:gate}),original=h.context.current.current;
    const task=h.context.run('recommend');await flush();
    h.analyses[0].resolve(modelResult(original));await flush();
    h.context.commit({...h.context.current.current,players:original.players.map(player=>({...player,items:[{itemID:3115}]}))});
    gate.resolve();await task;
    expect(h.writes).toHaveLength(1);expect(h.publications()).toHaveLength(1);
    expect(h.publications()[0].args.payload.ranking.contextChanged).toBe(true);
    expect(h.analyses).toHaveLength(1);
  });

  it('rejects double click while the first model call is pending',async()=>{
    const h=harness(),first=h.context.run('recommend');await flush();
    await h.context.run('recommend');expect(h.analyses).toHaveLength(1);
    h.analyses[0].resolve(modelResult(h.context.current.current));await first;
    expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('preserves a same-context model result when the OCR panel disappears and reappears',async()=>{
    const h=harness();h.cacheModel();h.context.seenIds.current='previous-scan';
    await h.scan([]);await h.scan([]);await h.scan();
    expect(h.errors).toEqual([]);
    expect(h.context.localRecommendation.result.source).toBe('model');
    expect(h.publications().every(call=>call.args.payload.ranking.source==='model')).toBe(true);
    expect(h.analyses).toHaveLength(0);
  });
  it('does not erase or rebill a completed automatic result when another player buys equipment',async()=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(1200);await h.scan();
    h.analyses[0].resolve(modelResult(h.context.current.current));await flush();
    const original=h.context.current.current;
    h.context.commit({...original,players:original.players.map((p,index)=>index?{...p,items:[{itemID:42}]}:p)});
    h.context.restored();await flush();h.advance(9000);await h.scan();h.advance(1200);await h.scan();
    expect(h.context.localRecommendation.result).toMatchObject({source:'model',contextChanged:true});
    expect(h.publications().at(-1).args.payload.ranking).toMatchObject({source:'model',contextChanged:true});
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });
  it('updates the same candidate group after equipment changes without activating its window again',async()=>{
    const h=harness({autoRecommend:false});await h.scan();
    const opensBefore=h.trace.filter(event=>event[0]==='overlay_open').length;
    const publicationsBefore=h.publications().length;
    const original=h.context.current.current;
    h.context.commit({...original,players:original.players.map((player,index)=>index===0?{...player,items:[{itemID:1036}]}:player)});
    await h.scan();
    expect(h.publications().length).toBeGreaterThan(publicationsBefore);
    expect(h.trace.filter(event=>event[0]==='overlay_open')).toHaveLength(opensBefore);
    expect(h.errors).toEqual([]);expect(h.analyses).toHaveLength(0);
  });
  it('restores a saved same-choice model result after restarting without another paid request',async()=>{
    const h=harness({autoRecommend:true}),session=h.context.current.current;
    const {decisions,samples,...context}=session;
    h.context.commit({...session,decisions:[{at:new Date().toISOString(),context,result:modelResult(session)}]});
    h.context.restored();await flush();await h.scan();h.advance(1200);await h.scan();
    expect(h.context.localRecommendation.result.source).toBe('model');
    expect(h.publications().every(p=>p.args.payload.ranking.source==='model')).toBe(true);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
  });

  it.each(['knowledge','next-game'])('rejects a late OCR response after %s changes',async change=>{
    const h=harness(),gate=deferred();h.scans.push(gate.promise);
    h.context.detectAugments(h.context.current.current);await flush();
    if(change==='knowledge')h.context.knowledgeChanged();
    else h.context.commit({...playing(),id:'next-session',matchId:'5678'});
    gate.resolve({candidates:playing().candidates,source:'synthetic',elapsedMs:1,model:'offline'});await flush();
    expect(h.publications()).toHaveLength(0);expect(h.analyses).toHaveLength(0);
    expect(h.context.scanning.current).toBe(false);
  });

  it('explicit historical review makes one model request and never publishes to the live overlay',async()=>{
    const session={...playing(),phase:'EndOfGame',archived:true,endedAt:new Date().toISOString()};
    const h=harness({session}),task=h.context.run('review');await flush();
    expect(h.analyses).toHaveLength(1);
    h.analyses[0].resolve({summary:'synthetic review',lessons:[],caveats:[]});await task;
    expect(h.errors).toEqual([]);expect(h.writes).toHaveLength(1);
    expect(h.writes[0].review.summary).toBe('synthetic review');
    expect(h.publications()).toHaveLength(0);
  });

  it.each([null,{connection:'disconnected',phase:'InProgress',gameId:'1234',liveData:null}])('does not restore a stale overlay without a fresh live snapshot (%j)',async snapshot=>{
    const h=harness();h.context.snapshotRef.current=snapshot;
    h.context.restored();await flush();
    expect(h.publications()).toHaveLength(0);expect(h.analyses).toHaveLength(0);
  });

  it('invalidates the old overlay after manual candidate correction without calling a model',async()=>{
    const h=harness();h.cacheModel();
    h.context.patch({candidates:h.context.current.current.candidates.map((candidate,index)=>index?candidate:{...candidate,name:'manual unmatched name',description:'manual complete effect'})});
    h.context.restored();await flush();
    const invalidated=h.calls.some(call=>call.command==='overlay_close')||h.publications().some(call=>call.args.payload.ranking.source==='recognition');
    expect(invalidated).toBe(true);expect(h.analyses).toHaveLength(0);
    expect(h.calls.some(call=>call.command==='score_candidates')).toBe(false);
  });
});

describe('actual opt-in automatic model recommendation flow',()=>{
  const differentCandidates=(n=1)=>playing().candidates.map((candidate,index)=>({...candidate,id:`${n}-${index}`,name:`synthetic group ${n} option ${index}`}));
  const stabilize=async h=>{await h.scan();h.advance(AUTO_STABLE_MS);await h.scan();};
  const finish=async h=>{const request=h.analyses.at(-1);request.resolve(modelResult(request.args.request.context));await flush();};
  const modelPublications=h=>h.publications().filter(call=>call.args.payload.ranking.source==='model');

  it.each(['opt-in','consent','empty-key','invalid-model','paused','historical','collection-disabled','updating'])('never bills when %s is unavailable',async unavailable=>{
    const h=harness({autoRecommend:true});
    if(unavailable==='opt-in')h.settings({autoRecommend:false});
    if(unavailable==='consent')h.settings({consent:false});
    if(unavailable==='empty-key')h.settings({apiKey:''});
    if(unavailable==='invalid-model')h.settings({model:{...h.context.model,name:''}});
    if(unavailable==='paused')h.context.collectionPaused.current=true;
    if(unavailable==='historical')h.context.config.current.historical=true;
    if(unavailable==='collection-disabled')h.context.config.current.auto=false;
    if(unavailable==='updating')h.settings({updating:true});
    await stabilize(h);h.advance(8000);await h.scan();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.calls.some(call=>call.command==='score_candidates')).toBe(false);
  });

  it('actively performs a second real capture after the first complete observation',async()=>{
    const h=harness({autoRecommend:true});await h.scan();
    expect(h.analyses).toHaveLength(0);
    h.scans.push({candidates:playing().candidates,source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(2);
    expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it.each(['off','consent','paused','historical','next-game','changed','miss'])('does not bill from a queued confirmation after %s',async change=>{
    const h=harness({autoRecommend:true});await h.scan();
    if(change==='off')h.settings({autoRecommend:false});
    if(change==='consent')h.settings({consent:false});
    if(change==='paused')h.context.collectionPaused.current=true;
    if(change==='historical')h.context.config.current.historical=true;
    if(change==='next-game')h.context.commit({...playing(),id:'next',matchId:'5678'});
    if(change==='changed')h.context.commit({...h.context.current.current,candidates:differentCandidates()});
    if(change==='miss'){
      await h.scan([]);
      for(let n=0;n<4;n++)h.scans.push({candidates:[],source:'capture',elapsedMs:1});
    }
    await vi.advanceTimersByTimeAsync(CANDIDATE_BURST_WINDOW_MS+1);await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.confirmationScan.current).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it('recovers a 3 → 0 → 3 → 3 sequence using real confirmation captures without waiting for the ordinary poll',async()=>{
    const h=harness({autoRecommend:true});await h.scan();
    for(const candidates of [[],playing().candidates,playing().candidates])h.scans.push({candidates,source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS);await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.lastAutoScan.current).toBeNull();
    await vi.advanceTimersByTimeAsync(OCR_FIRST_MISS_IDLE_MS);await flush();
    expect(h.analyses).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(4);
    expect(h.context.poll).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    await finish(h);
  });

  it('never bills from pixel probes, even if a malformed probe carries retained candidates',async()=>{
    const h=harness({autoRecommend:true});
    await h.scan(playing().candidates,{probeOnly:true,panelState:'likely'});
    h.advance(1000);await h.scan(playing().candidates,{probeOnly:true,panelState:'likely'});
    expect(h.analyses).toHaveLength(0);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.autoRecommendationGate.current.firstObservedAt(h.context.current.current)).toBeNull();
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'waiting',code:'waiting-panel'});
    await h.scan();expect(h.analyses).toHaveLength(0);
    h.advance(1000);await h.scan();expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it('uses the remaining burst budget after a two-card partial without inventing the missing third candidate',async()=>{
    const h=harness({autoRecommend:true});await h.scan();
    for(const candidates of [[],playing().candidates.slice(0,2),playing().candidates,playing().candidates])h.scans.push({candidates,source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS*2);await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.lastAutoScan.current).toBeNull();
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS+OCR_FIRST_MISS_IDLE_MS);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(5);
    expect(h.analyses).toHaveLength(1);expect(h.analyses[0].args.request.context.candidates).toHaveLength(3);
    expect(h.errors).toEqual([]);await finish(h);
  });

  it('exhausts its finite miss budget instead of looping or billing on retained candidates',async()=>{
    const h=harness({autoRecommend:true});await h.scan();
    for(let n=0;n<4;n++)h.scans.push({candidates:[],source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_BURST_WINDOW_MS+1);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(5);
    expect(h.context.confirmationScan.current).toBeNull();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(5);
    expect(h.errors).toEqual([]);
    await h.scan();
    expect(h.analyses).toHaveLength(0);expect(h.context.confirmationScan.current).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(6);
  });

  it('never fills a missing third card from the previous complete scan while rapid retries remain partial',async()=>{
    const h=harness({autoRecommend:true});await h.scan();
    for(let n=0;n<4;n++)h.scans.push({candidates:playing().candidates.slice(0,2),source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_BURST_WINDOW_MS+1);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(5);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.lastAutoScan.current).toBeNull();expect(h.context.confirmationScan.current).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it.each(['skip','error'])('stops a rapid confirmation burst immediately on capture %s',async reason=>{
    const h=harness({autoRecommend:true});await h.scan();
    if(reason==='skip')h.scans.push({candidates:[],source:'capture',elapsedMs:1,skipped:true,reason:'not-foreground'});
    else {const failure=Promise.reject(new Error('synthetic capture unavailable'));void failure.catch(()=>{});h.scans.push(failure);}
    await vi.advanceTimersByTimeAsync(CANDIDATE_BURST_WINDOW_MS+1);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(2);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.confirmationScan.current).toBeNull();expect(h.context.lastAutoScan.current).toBeNull();
    expect(h.errors).toHaveLength(reason==='error'?1:0);
  });

  it('does not start rapid retries or a paid call from a first two-card observation',async()=>{
    const h=harness({autoRecommend:true});await h.scan(playing().candidates.slice(0,2));
    await vi.advanceTimersByTimeAsync(CANDIDATE_BURST_WINDOW_MS+1);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(1);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.confirmationScan.current).toBeNull();expect(h.errors).toEqual([]);
  });

  it('does not run a throttled confirmation after the short burst window expires',async()=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(CANDIDATE_BURST_WINDOW_MS+1);
    h.context.confirmCandidateScan();await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(1);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.confirmationScan.current).toBeNull();expect(h.errors).toEqual([]);
  });

  it('native ticks can drain a due confirmation without replaying the old frame',async()=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(2000);
    h.scans.push({candidates:playing().candidates,source:'capture',elapsedMs:1});
    h.syncCollector();
    h.context.confirmCandidateScan();await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(2);
    expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it('publishes a specific key blocker without sending an analysis request',async()=>{
    const h=harness({autoRecommend:true});h.settings({apiKey:''});await h.scan();
    const progress=h.context.recommendationProgress.current.get(h.context.current.current);
    expect(progress).toMatchObject({phase:'blocked',code:'missing-key'});
    expect(h.calls.filter(c=>c.command==='overlay_analysis_status').at(-1).args.payload.analysis).toEqual(progress);
    expect(h.analyses).toHaveLength(0);
  });

  it('analyzes incomplete opponent data once without rebilling when the roster arrives',async()=>{
    const s=playing();s.players[1].champion='';const h=harness({autoRecommend:true,session:s});await stabilize(h);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    await finish(h);
    h.context.commit({...h.context.current.current,players:playing().players});h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it.each(['empty','self-only','unknown-team','unknown-champion'])('analyzes %s roster after two fresh scans, without fabricating players',async kind=>{
    const s=playing();
    if(kind==='empty'){s.players=[];s.ownPlayerId='';}
    if(kind==='self-only')s.players=s.players.slice(0,1);
    if(kind==='unknown-team')s.players.forEach(player=>{player.team='UNKNOWN';});
    if(kind==='unknown-champion')s.players.forEach(player=>{player.champion='';});
    const h=harness({autoRecommend:true,session:s});await stabilize(h);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    expect(h.analyses[0].args.request.context.players).toEqual(s.players);
    expect(h.analyses[0].args.request.context.ownPlayerId).toBe(s.ownPlayerId);
    expect(modelPublications(h)).toHaveLength(0);await finish(h);
    expect(modelPublications(h)).toHaveLength(1);
    h.context.commit({...h.context.current.current,players:playing().players,ownPlayerId:playing().ownPlayerId});
    h.advance(9000);await stabilize(h);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
  });

  it('allows a manual candidate comparison with an empty roster',async()=>{
    const s={...playing(),players:[],ownPlayerId:''},h=harness({session:s});
    const task=h.context.run('recommend');await flush();
    expect(h.analyses).toHaveLength(1);await finish(h);await task;
    expect(h.errors).toEqual([]);expect(h.writes).toHaveLength(1);
  });

  it('keeps a safe HTTP failure visible through later scans and settings changes',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    h.analyses[0].reject(new Error('HTTP status server error (500) for url https://secret.invalid/?api_key=private-value'));await flush();
    h.settings({apiKey:''});await h.scan();h.settings({apiKey:'fake-restored'});h.advance(9000);await h.scan();
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'failed',code:'http-5xx'});
    expect(h.analyses).toHaveLength(1);
    const logs=h.calls.filter(c=>c.command==='recommendation_diagnostic');
    expect(logs.some(c=>c.args.entry.httpStatus===500)).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/private-value|secret\.invalid|synthetic#1/);
    expect(JSON.stringify(h.calls.filter(c=>c.command==='overlay_analysis_status'))).not.toContain('private-value');
  });

  it.each([0,1])('restores a durable delayed result on the same choice at knowledge revision %i without another request',async revision=>{
    const h=harness({autoRecommend:true});h.context.knowledgeRevision.current=revision;await stabilize(h);
    h.advance(15001);await finish(h);expect(modelPublications(h)).toHaveLength(0);
    await h.scan();
    expect(modelPublications(h)).toHaveLength(1);expect(h.analyses).toHaveLength(1);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('complete');
  });

  it('does not restore delayed results after their knowledge version changes',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);h.context.knowledgeRevision.current++;
    h.advance(15001);await finish(h);await h.scan();
    expect(modelPublications(h)).toHaveLength(0);expect(h.analyses).toHaveLength(1);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).code).toBe('saved-context-changed');
  });

  it('does not claim an in-memory result is saved after persistence failed',async()=>{
    const saveGate=deferred(),h=harness({autoRecommend:true,saveGate});await stabilize(h);
    h.analyses[0].resolve(modelResult(h.context.current.current));await flush();saveGate.reject(new Error('disk unavailable'));await flush();
    h.advance(9000);await h.scan();h.context.restored();await flush();
    expect(modelPublications(h)).toHaveLength(0);expect(h.analyses).toHaveLength(1);
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'failed',code:'save-or-publish-failed'});
  });

  it.each([false,true])('acknowledges a later successful snapshot save without rebilling (knowledge changed: %s)',async knowledgeChanged=>{
    const saveGate=deferred(),h=harness({autoRecommend:true,saveGate});await stabilize(h);
    h.analyses[0].resolve(modelResult(h.context.current.current));await flush();saveGate.reject(new Error('disk unavailable'));await flush();
    expect(h.writes).toHaveLength(0);expect(modelPublications(h)).toHaveLength(0);
    if(knowledgeChanged)h.context.knowledgeRevision.current++;
    await h.context.save();expect(h.writes).toHaveLength(1);
    h.advance(9000);await h.scan();
    expect(modelPublications(h)).toHaveLength(knowledgeChanged?0:1);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    if(!knowledgeChanged)expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('complete');
  });

  it('acknowledges a timed-out write only after its actual background completion',async()=>{
    const saveGate=deferred(),h=harness(),original=h.context.current.current;
    h.context.saver.current=new SaveQueue(async value=>{await saveGate.promise;await h.context.writeSnapshot(value);},10);
    const run=h.context.run('recommend');await flush();h.analyses[0].resolve(modelResult(original));await flush();
    await vi.advanceTimersByTimeAsync(11);await run;
    expect(modelPublications(h)).toHaveLength(0);expect(h.writes).toHaveLength(0);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('failed');
    saveGate.resolve();await h.context.saver.current.idle();h.context.restored();await flush();
    expect(h.writes).toHaveLength(1);expect(modelPublications(h)).toHaveLength(1);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a model snapshot replaced by save-queue coalescing',async()=>{
    const saveGate=deferred(),h=harness({saveGate}),first=h.context.save();
    const run=h.context.run('recommend');await flush();h.analyses[0].resolve(modelResult(h.context.current.current));await flush();
    const superseding=h.context.save({...h.context.current.current,decisions:[]});
    saveGate.resolve();await Promise.all([first,run,superseding]);
    expect(h.writes).toHaveLength(2);expect(h.writes.every(snapshot=>snapshot.decisions.length===0)).toBe(true);
    h.context.restored();await flush();
    expect(modelPublications(h)).toHaveLength(0);
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'failed',code:'save-or-publish-failed'});
    expect(h.analyses).toHaveLength(1);
  });

  it('requires two fresh stable scans for the configured interval, then makes exactly one model request',async()=>{
    const h=harness({autoRecommend:true});
    await h.scan();h.advance(AUTO_STABLE_MS-1);await h.scan();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    h.advance(1);await h.scan();expect(h.analyses).toHaveLength(1);
    await finish(h);h.advance(9000);await h.scan();h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    expect(modelPublications(h)).toHaveLength(1);
    expect(h.trace.at(-1)).toEqual(['overlay_open']);
  });

  it('does not call a model merely by restoring already saved candidates',async()=>{
    const h=harness({autoRecommend:true});h.context.restored();await flush();
    h.advance(12000);h.context.restored();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
  });

  it('counts a failed request and never automatically retries that candidate group',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    h.analyses[0].reject(new Error('synthetic model unavailable'));await flush();
    h.advance(9000);await h.scan();h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    expect(modelPublications(h)).toHaveLength(0);expect(h.errors.some(error=>error.includes('模型分析未完成'))).toBe(true);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('failed');
  });

  it('deduplicates a manual request before subsequent automatic scans',async()=>{
    const h=harness({autoRecommend:true}),task=h.context.run('recommend');await flush();
    await finish(h);await task;h.advance(9000);await stabilize(h);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('starts a new stable candidate group without inheriting the previous group eight-second interval',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);await finish(h);
    h.advance(NEW_REQUEST_INTERVAL_MS-AUTO_STABLE_MS);await h.scan(differentCandidates());h.advance(AUTO_STABLE_MS);await h.scan();
    expect(h.analyses).toHaveLength(2);await finish(h);
  });

  it.each(['round','match'])('does not carry an old group eight-second interval into a new %s',async change=>{
    const h=harness({autoRecommend:true});await stabilize(h);await finish(h);
    const next=change==='round'?{...playing(),candidateBand:7,liveData:{...playing().liveData,activePlayer:{riotId:'synthetic#1',level:7}}}:{...playing(),id:'next-session',matchId:'5678'};
    h.context.commit(next);h.context.snapshotRef.current={connection:'connected',phase:'InProgress',gameId:next.matchId,liveData:next.liveData};
    h.advance(NEW_REQUEST_INTERVAL_MS-AUTO_STABLE_MS);await stabilize(h);
    expect(h.analyses).toHaveLength(2);expect(h.analyses[1].args.request.context.matchId).toBe(next.matchId);
    expect(h.analyses[1].args.request.context.candidateBand).toBe(next.candidateBand);await finish(h);
  });

  it('waits only the remaining short interval then performs a real fresh capture before dispatch',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);await finish(h);
    await h.scan(differentCandidates());
    h.scans.push({candidates:differentCandidates(),source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS);await flush();
    expect(h.analyses).toHaveLength(1);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).code).toBe('request-cooldown');
    expect(h.context.confirmationScan.current.at-Date.now()).toBe(CANDIDATE_RECHECK_MS);
    h.scans.push({candidates:differentCandidates(),source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS);await flush();
    expect(h.analyses).toHaveLength(2);expect(h.context.bumpUsage).toHaveBeenCalledTimes(2);
    expect(h.errors).toEqual([]);await finish(h);
  });

  it('does not consume an interval or charge when local preparation is cancelled before dispatch',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    h.settings({consent:false});gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.requestInterval.current.remaining('recommend',h.context.current.current)).toBe(0);
    h.settings({consent:true});await h.scan();
    expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it('does not consume a request interval on failed local knowledge retrieval',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    gate.reject(new Error('synthetic local read failure'));await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.requestInterval.current.remaining('recommend',h.context.current.current)).toBe(0);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).code).toBe('pre-send-cancelled');
  });

  it('measures the same-group manual retry interval from actual dispatch rather than the start of retrieval',async()=>{
    const gate=deferred(),h=harness({retrievalGate:gate});const first=h.context.run('recommend');await flush();
    h.advance(REPEAT_REQUEST_INTERVAL_MS+1);gate.resolve();await flush();
    expect(h.analyses).toHaveLength(1);await finish(h);await first;
    await h.context.run('recommend');expect(h.analyses).toHaveLength(1);
    h.advance(REPEAT_REQUEST_INTERVAL_MS-1);await h.context.run('recommend');expect(h.analyses).toHaveLength(1);
    h.advance(1);const second=h.context.run('recommend');await flush();
    expect(h.analyses).toHaveLength(2);await finish(h);await second;
  });

  it('keeps eight-second same-group manual retry protection after a paid failure',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    h.analyses[0].reject(new Error('http-status-429'));await flush();
    h.advance(NEW_REQUEST_INTERVAL_MS);await h.context.run('recommend');expect(h.analyses).toHaveLength(1);
    await h.scan();expect(h.analyses).toHaveLength(1);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('failed');
    h.advance(REPEAT_REQUEST_INTERVAL_MS-NEW_REQUEST_INTERVAL_MS);const task=h.context.run('recommend');await flush();
    expect(h.analyses).toHaveLength(2);await finish(h);await task;
  });

  it('retains the single in-flight request guard even after the short interval expires',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    h.advance(NEW_REQUEST_INTERVAL_MS);await h.scan(differentCandidates());h.advance(AUTO_STABLE_MS);await h.scan();
    await h.context.run('recommend');expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    await finish(h);await h.scan();expect(h.analyses).toHaveLength(2);await finish(h);
  });

  it('ignores a legacy saved daily cap even after many requests today',async()=>{
    const h=harness({autoRecommend:true,dailyLimit:4,used:47});await stabilize(h);await finish(h);
    h.advance(9000);await h.scan(differentCandidates());h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(2);expect(h.context.bumpUsage).toHaveBeenCalledTimes(2);await finish(h);
    expect(h.context.setDailyUsed).toHaveBeenLastCalledWith(49);
  });

  it('allows the initial group and three rerolls, then blocks a fifth group in the same round',async()=>{
    const h=harness({autoRecommend:true});
    for(let group=1;group<=5;group++){
      h.advance(9000);await h.scan(differentCandidates(group));h.advance(1000);await h.scan();
      if(group<=4){expect(h.analyses).toHaveLength(group);await finish(h);}
    }
    expect(h.analyses).toHaveLength(4);expect(h.context.bumpUsage).toHaveBeenCalledTimes(4);
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'blocked',code:'round-limit',message:'本轮自动分析已达 4 次上限，可手动分析。'});
  });

  it('gives the next round and next match their own four requests even with a legacy daily limit of four',async()=>{
    const h=harness({autoRecommend:true,dailyLimit:4,used:40});
    for(let round=0;round<3;round++){
      if(round===1){
        h.context.current.current={...h.context.current.current,candidateBand:7,liveData:{...h.context.current.current.liveData,activePlayer:{riotId:'synthetic#1',level:7}}};
        h.context.snapshotRef.current={...h.context.snapshotRef.current,liveData:h.context.current.current.liveData};
      }
      if(round===2){
        h.context.current.current={...playing(),id:'synthetic-next-session',matchId:'5678'};
        h.context.snapshotRef.current={...h.context.snapshotRef.current,gameId:'5678',liveData:h.context.current.current.liveData};
      }
      for(let group=1;group<=5;group++){
        h.advance(9000);await h.scan(differentCandidates(group));h.advance(1000);await h.scan();
        expect(h.analyses).toHaveLength(round*4+Math.min(group,4));
        if(group<=4)await finish(h);
      }
    }
    expect(h.context.bumpUsage).toHaveBeenCalledTimes(12);
    expect(h.context.setDailyUsed).toHaveBeenLastCalledWith(52);
  });

  it('publishes new OCR candidates but does not bill until a collector request starts after the group appeared',async()=>{
    const h=harness({autoRecommend:true,autoCollector:false});
    const oldStart=h.context.snapshotPollStartedAt.current;
    await stabilize(h);
    expect(h.publications().some(call=>call.args.payload.ranking.source==='recognition')).toBe(true);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({code:'refreshing-context'});
    h.context.snapshotRef.current.observedAt=new Date().toISOString();
    h.context.snapshotPollStartedAt.current=oldStart; // late completion of an old API request is insufficient
    await h.scan();expect(h.analyses).toHaveLength(0);
    h.context.snapshotPollStartedAt.current=Date.now()-1;
    h.context.snapshotRef.current.observedAt=new Date().toISOString();
    await h.scan();expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it('does not analyze newly observed level-seven options under retained level-six evidence and then bill again',async()=>{
    const s=playing();s.liveData.activePlayer.level=6;s.liveData.gameData.gameTime=200;
    const h=harness({autoRecommend:true,autoCollector:false,session:s});
    const newOptions=differentCandidates(7);
    await h.scan(newOptions);h.advance(600);await h.scan(newOptions);
    expect(h.analyses).toHaveLength(0);
    const liveData={...s.liveData,activePlayer:{...s.liveData.activePlayer,level:7}};
    h.context.commit({...h.context.current.current,liveData});
    h.context.snapshotRef.current={...h.context.snapshotRef.current,liveData,observedAt:new Date().toISOString()};
    h.context.snapshotPollStartedAt.current=Date.now()-1;
    await h.scan(newOptions);expect(h.context.current.current.candidateBand).toBe(7);
    h.advance(600);h.context.snapshotPollStartedAt.current=Date.now()-1;h.context.snapshotRef.current.observedAt=new Date().toISOString();
    await h.scan(newOptions);expect(h.analyses).toHaveLength(1);
    expect(h.analyses[0].args.request.context.candidateBand).toBe(7);
    await finish(h);h.advance(1000);await h.scan(newOptions);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('rechecks fresh round evidence after knowledge retrieval instead of paying on an expired snapshot',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});
    await stabilize(h);expect(h.analyses).toHaveLength(0);
    h.advance(5001);gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({code:'pre-send-cancelled'});
  });

  it('deduplicates unchanged sidebar status messages during repeated visible-panel scans',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);await finish(h);await h.scan();
    const statusCalls=h.calls.filter(call=>call.command==='overlay_analysis_status').length;
    for(let count=0;count<4;count++)await h.scan();
    expect(h.calls.filter(call=>call.command==='overlay_analysis_status')).toHaveLength(statusCalls);
    expect(h.analyses).toHaveLength(1);
  });

  it.each(['miss','skip','changed','expired-gap'])('requires a new stable observation after %s',async invalidation=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(600);
    if(invalidation==='miss')await h.scan([]);
    if(invalidation==='skip')await h.scan([],{skipped:true,reason:'not-foreground'});
    if(invalidation==='changed')await h.scan(differentCandidates());
    if(invalidation==='expired-gap')h.advance(15000);
    h.advance(400);await h.scan(invalidation==='changed'?playing().candidates:h.context.current.current.candidates);
    h.advance(AUTO_STABLE_MS-1);await h.scan();expect(h.analyses).toHaveLength(0);
    h.advance(1);await h.scan();expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it.each(['name','description'])('does not reuse cached OCR stability when the same candidate IDs have different %s',async field=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(1000);
    const changed=playing().candidates.map((candidate,index)=>index?candidate:{...candidate,[field]:`new synthetic ${field}`});
    await h.scan(changed);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.current.current.candidates[0][field]).toBe(`new synthetic ${field}`);
    h.advance(1000);await h.scan(changed);
    expect(h.analyses).toHaveLength(1);expect(h.analyses[0].args.request.context.candidates[0][field]).toBe(`new synthetic ${field}`);
    await finish(h);
  });

  it('never substitutes retained full descriptions for an incomplete same-ID OCR observation',async()=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(1000);
    const incomplete=playing().candidates.map((candidate,index)=>index?candidate:{...candidate,description:''});
    await h.scan(incomplete);h.advance(1000);await h.scan(incomplete);
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.context.lastAutoScan.current).toBeNull();
    await h.scan(playing().candidates);expect(h.analyses).toHaveLength(0);
    h.advance(1000);await h.scan();expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it('does not count the pre-send check as a second OCR frame after a retrieval-time skip',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    expect(h.calls.filter(call=>call.command==='knowledge_retrieve')).toHaveLength(1);
    await h.scan([],{skipped:true,reason:'not-foreground'});
    await h.scan();h.advance(1000);gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(modelPublications(h)).toHaveLength(0);
  });

  it('does not apply in-flight miss grace before the model request is dispatched',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('preparing');
    await h.scan([]);expect(h.context.lastAutoScan.current).toBeNull();
    gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(modelPublications(h)).toHaveLength(0);
  });

  it('allows queued real confirmations while knowledge retrieval has an active analysis target',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    await h.scan([]);
    for(let n=0;n<2;n++)h.scans.push({candidates:playing().candidates,source:'capture',elapsedMs:1});
    await vi.advanceTimersByTimeAsync(CANDIDATE_RECHECK_MS+OCR_FIRST_MISS_IDLE_MS);await flush();
    expect(h.calls.filter(call=>call.command==='ocr_scan')).toHaveLength(5);
    expect(h.context.lastAutoScan.current?.at).toBe(Date.now());
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    gate.resolve();await flush();
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);await finish(h);
  });

  it.each(['pause-and-resume','return-to-live'])('discards prior OCR stability on %s',async transition=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(1000);
    if(transition==='pause-and-resume'){
      h.context.setAuto(false);expect(h.context.config.current.auto).toBe(false);
      h.context.setAuto(true);expect(h.context.config.current.auto).toBe(true);
    }else h.context.resumeLive();
    expect(h.context.lastAutoScan.current).toBeNull();
    await h.scan();expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    h.advance(1000);await h.scan();expect(h.analyses).toHaveLength(1);await finish(h);
  });

  it.each(['auto-off','consent-revoked','model-changed','key-changed','updating','paused','disconnected'])('rechecks %s after retrieval and before billing',async change=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    expect(h.calls.some(call=>call.command==='knowledge_retrieve')).toBe(true);expect(h.analyses).toHaveLength(0);
    if(change==='auto-off')h.settings({autoRecommend:false});
    if(change==='consent-revoked')h.settings({consent:false});
    if(change==='model-changed')h.settings({model:{...h.context.model,name:'another-offline-model'}});
    if(change==='key-changed')h.settings({apiKey:'another-fake-key'});
    if(change==='updating')h.settings({updating:true});
    if(change==='paused')h.context.collectionPaused.current=true;
    if(change==='disconnected')h.context.snapshotRef.current={connection:'disconnected',phase:'InProgress',gameId:'1234',liveData:null};
    gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();expect(modelPublications(h)).toHaveLength(0);
  });

  it('does not bill if retrieval outlives the last real OCR observation',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    h.advance(15001);gate.resolve();await flush();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(modelPublications(h)).toHaveLength(0);
  });

  it('uses current model settings even if the background detector was created before they changed',async()=>{
    const h=harness({autoRecommend:false,consent:false});
    h.settings({autoRecommend:true,consent:true,model:{...h.context.model,name:'latest-offline-model'},apiKey:'latest-fake-key'});
    await stabilize(h);expect(h.analyses).toHaveLength(1);
    expect(h.analyses[0].args.request.model.name).toBe('latest-offline-model');
    expect(h.analyses[0].args.request.model.apiKey).toBe('latest-fake-key');
    await finish(h);
  });

  it.each(['candidates','phase','consent','expired-scan'])('saves but does not publish a model response after %s becomes stale',async change=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    if(change==='candidates')await h.scan(differentCandidates());
    if(change==='phase')h.context.snapshotRef.current={...h.context.snapshotRef.current,phase:'EndOfGame'};
    if(change==='consent')h.settings({consent:false});
    if(change==='expired-scan')h.advance(15001);
    const opensBefore=h.trace.filter(event=>event[0]==='overlay_open').length;
    await finish(h);
    expect(h.writes).toHaveLength(1);expect(h.writes[0].decisions).toHaveLength(1);
    expect(modelPublications(h)).toHaveLength(0);
    expect(h.trace.filter(event=>event[0]==='overlay_open')).toHaveLength(opensBefore);
  });

  it('reopens the sidebar for a fresh automatic result only after the saved result is published',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,saveGate:gate});await stabilize(h);
    h.trace.length=0;h.analyses[0].resolve(modelResult(h.analyses[0].args.request.context));await flush();
    expect(modelPublications(h)).toHaveLength(0);expect(h.trace.some(event=>event[0]==='overlay_open')).toBe(false);
    gate.resolve();await flush();
    expect(h.trace).toEqual([['save-start'],['save-durable'],['local','model'],['publish','model'],['overlay_open']]);
    expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a received model result from waiting for its durable save',async()=>{
    const gate=deferred(),h=harness({autoRecommend:true,saveGate:gate});await stabilize(h);
    await finish(h);
    expect(h.context.recommendationProgress.current.get(h.context.current.current)).toMatchObject({phase:'analyzing',code:'result-received'});
    expect(h.calls.filter(call=>call.command==='recommendation_diagnostic').some(call=>call.args.entry.stage==='analyzing'&&call.args.entry.code==='result-received')).toBe(true);
    expect(modelPublications(h)).toHaveLength(0);expect(h.writes).toHaveLength(0);
    gate.resolve();await flush();
    expect(h.context.recommendationProgress.current.get(h.context.current.current).phase).toBe('complete');
    expect(modelPublications(h)).toHaveLength(1);expect(h.analyses).toHaveLength(1);
  });

  it('publishes a fast in-flight score after one transient miss without reopening the sidebar',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);h.advance(700);
    await h.scan([]);
    expect(h.context.lastAutoScan.current).not.toBeNull();
    const opensBefore=h.trace.filter(event=>event[0]==='overlay_open').length;
    await finish(h);
    expect(h.writes).toHaveLength(1);expect(h.writes[0].decisions).toHaveLength(1);
    expect(modelPublications(h)).toHaveLength(1);
    expect(h.trace.filter(event=>event[0]==='overlay_open')).toHaveLength(opensBefore);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it.each(['expired-before-miss','expired-after-miss','two-misses','skip'])('archives but does not publish after %s invalidates in-flight miss grace',async change=>{
    const h=harness({autoRecommend:true});await stabilize(h);
    if(change==='expired-before-miss')h.advance(2_001);
    await h.scan([],{skipped:change==='skip',...(change==='skip'?{reason:'not-foreground'}:{})});
    if(change==='expired-after-miss')h.advance(2_001);
    if(change==='two-misses')await h.scan([]);
    const opensBefore=h.trace.filter(event=>event[0]==='overlay_open').length;
    await finish(h);
    expect(h.writes).toHaveLength(1);expect(h.writes[0].decisions).toHaveLength(1);
    expect(modelPublications(h)).toHaveLength(0);
    expect(h.trace.filter(event=>event[0]==='overlay_open')).toHaveLength(opensBefore);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it.each(['consent','candidates','next-game'])('does not reopen if %s changes while model publication is pending',async change=>{
    const gate=deferred(),h=harness({autoRecommend:true,publicationGate:gate});await stabilize(h);
    const opensBefore=h.trace.filter(event=>event[0]==='overlay_open').length;
    await finish(h);expect(modelPublications(h)).toHaveLength(1);
    if(change==='consent')h.settings({consent:false});
    if(change==='candidates')h.context.commit({...h.context.current.current,candidates:differentCandidates()});
    if(change==='next-game')h.context.commit({...playing(),id:'next-session',matchId:'5678'});
    gate.resolve();await flush();
    expect(h.trace.filter(event=>event[0]==='overlay_open')).toHaveLength(opensBefore);
    expect(h.writes).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });
});
