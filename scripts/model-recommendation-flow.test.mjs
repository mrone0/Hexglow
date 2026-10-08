import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {newSession, hasContent, synchronizeSelections, blockers} from '../src/domain.ts';
import {AnalysisTarget} from '../src/analysis.ts';
import {analysisSource} from '../src/analysisGate.ts';
import {liveOverviewState} from '../src/LiveOverview.tsx';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, ownLevel} from '../src/level.ts';
import {markCandidateEdits, mergeDetectedCandidates} from '../src/candidates.ts';
import {SaveQueue} from '../src/saveQueue.ts';
import {createLocalRecommendation, localRecommendationKey, recognizedCandidates, modelRecommendation, selectLocalRecommendation} from '../src/liveRecommendation.ts';
import {canPublishModelRecommendation, modelContextKey} from '../src/modelPublication.ts';
import {AutoRecommendationGate, autoRecommendationKey} from '../src/autoRecommendation.ts';
import {autoModelIdentity, automaticModelIssue} from '../src/autoModelConfig.ts';

// Run the actual application handlers with synthetic state/IPC only. Importing
// main.tsx would mount the desktop app and is intentionally never done here.
const file = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let detector, restored, knowledgeChanged, setAuto;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['run','patch','save','automaticIssue','maybeAutoRecommend','resumeLive'].includes(node.name?.text)) callbacks.set(node.name.text,node);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'detectAugments') detector = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'setAuto') setAuto = node.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements.some(element => element.getText(ast) === 'localScoreKey')) restored = node.arguments[0];
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'KnowledgePanel') knowledgeChanged = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onChanged')?.initializer?.expression;
  ts.forEachChild(node,visit);
}
visit(ast);
if (callbacks.size !== 6 || !detector || !restored || !knowledgeChanged || !setAuto) throw new Error('Actual model/recognition application handlers not found');
const compile = text => ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function flush(){for(let n=0;n<40;n++)await Promise.resolve();}

function playing(){
  return {...newSession(),id:'synthetic-session',matchId:'1234',phase:'InProgress',candidateBand:1,ownPlayerId:'synthetic#1',
    players:[{id:'synthetic#1',name:'synthetic',champion:'Ekko',team:'ORDER',items:[],augments:[],augmentsConfirmed:true},
      {id:'synthetic#2',name:'synthetic opponent',champion:'Lux',team:'CHAOS',items:[],augments:[],augmentsConfirmed:true}],
    candidates:[1,2,3].map(id=>({id:String(id),name:`candidate ${id}`,description:`complete effect ${id}`,source:'ocr'})),
    liveData:{activePlayer:{riotId:'synthetic#1',level:3},gameData:{gameTime:70},allPlayers:[]}};
}
function modelResult(session){return {summary:'synthetic model comparison',missingInformation:[],
  engine:{provider:'mock',model:'offline-only',latencyMs:1,confidenceKind:'model',scoringMode:'dynamic-model-v1'},
  ranking:session.candidates.map((candidate,index)=>({candidateId:candidate.id,score:80-index*10,confidence:0.8,reason:'synthetic reason',evidence:['synthetic source'],risks:[]}))};}

function harness({session=playing(),saveGate=null,retrievalGate=null,publicationGate=null,autoRecommend=false,consent=true,dailyLimit=20,used=0}={}){
  const calls=[],errors=[],writes=[],trace=[],analyses=[],scans=[];
  const model={provider:'openai',name:'offline-only',baseUrl:'https://api.openai.com/v1'};
  const analysisSettings={current:{model,apiKey:'not-a-real-key',consent,autoRecommend,dailyLimit,revision:0,updating:false}};
  const context=vm.createContext({Date,Promise,structuredClone,setTimeout,clearTimeout,
    AnalysisTarget,analysisSource,liveOverviewState,liveDetectionBand,augmentBand,ownLevel,
    markCandidateEdits,mergeDetectedCandidates,synchronizeSelections,hasContent,blockers,
    createLocalRecommendation,localRecommendationKey,recognizedCandidates,modelRecommendation,selectLocalRecommendation,
    canPublishModelRecommendation,modelContextKey,AutoRecommendationGate,autoRecommendationKey,autoModelIdentity,automaticModelIssue,
    current:{current:session},session,snapshotRef:{current:{connection:'connected',phase:'InProgress',gameId:session.matchId,liveData:session.liveData}},
    config:{current:{historical:false,view:'live',auto:true}},historical:false,epoch:{current:0},busyRef:{current:false},collectionPaused:{current:false},
    analysisTarget:{current:null},activeSession:{current:null},knowledgeRevision:{current:0},lastRun:{current:0},COOLDOWN_MS:8000,dailyLimit,
    consent,autoRecommend,model,apiKey:'not-a-real-key',analysisSettings,
    autoRecommendationGate:{current:new AutoRecommendationGate()},lastAutoScan:{current:null},runRef:{current:null},maybeAutoRecommendRef:{current:null},
    scanning:{current:false},seenMatch:{current:session.id},seenIds:{current:''},candidateRevision:{current:0},panelMisses:{current:0},
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
      if(command==='history_similarity')return [];
      if(command==='analyze_structured'){const request=deferred();analyses.push({...request,args});return request.promise;}
      if(command==='save_session'){trace.push(['save-start']);if(saveGate)await saveGate.promise;writes.push(structuredClone(args.session));trace.push(['save-durable']);return;}
      if(command==='ocr_scan'){if(!scans.length)throw new Error('Missing synthetic OCR scan');return scans.shift();}
      if(command==='overlay_publish'){trace.push(['publish',args.payload.ranking.source]);if(publicationGate&&args.payload.ranking.source==='model')await publicationGate.promise;return;}
      if(command==='overlay_open'||command==='overlay_close'){trace.push([command]);return;}
      throw new Error(`Unexpected IPC (no real API is allowed): ${command}`);
    },
  });
  context.saver={current:new SaveQueue(value=>context.invoke('save_session',{session:value}))};
  for(const callback of callbacks.values())vm.runInContext(compile(callback.getText(ast)),context);
  context.runRef.current=context.run;context.maybeAutoRecommendRef.current=context.maybeAutoRecommend;
  vm.runInContext(compile(`globalThis.detectAugments=${detector.getText(ast)};globalThis.restored=${restored.getText(ast)};globalThis.knowledgeChanged=${knowledgeChanged.getText(ast)};globalThis.setAuto=${setAuto.getText(ast)};`),context);
  return {context,calls,errors,writes,trace,analyses,scans,
    publications:()=>calls.filter(call=>call.command==='overlay_publish'),
    scan:async(candidates=context.current.current.candidates,extra={})=>{scans.push({candidates,source:'capture',elapsedMs:1,model:'offline',...extra});context.detectAugments(context.current.current);await flush();},
    settings:patch=>{analysisSettings.current={...analysisSettings.current,...patch,revision:analysisSettings.current.revision+1};},
    advance:ms=>{vi.setSystemTime(Date.now()+ms);},
    cacheModel:()=>context.setLocalRecommendation(createLocalRecommendation(context.current.current,modelRecommendation(context.current.current,modelResult(context.current.current)))),
  };
}

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('actual application model recommendation flow',()=>{
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
    expect(h.publications()).toHaveLength(0);expect(h.errors.some(e=>e.includes('disk unavailable'))).toBe(true);
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
    expect(h.analyses).toHaveLength(1);expect(h.writes).toHaveLength(1);expect(h.publications()).toHaveLength(0);
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
    expect(h.writes).toHaveLength(1);expect(h.publications()).toHaveLength(0);
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
  const stabilize=async h=>{await h.scan();h.advance(1000);await h.scan();};
  const finish=async h=>{const request=h.analyses.at(-1);request.resolve(modelResult(request.args.request.context));await flush();};
  const modelPublications=h=>h.publications().filter(call=>call.args.payload.ranking.source==='model');

  it.each(['opt-in','consent','empty-key','invalid-model','daily-cap','paused','historical','collection-disabled','updating'])('never bills when %s is unavailable',async unavailable=>{
    const h=harness({autoRecommend:true});
    if(unavailable==='opt-in')h.settings({autoRecommend:false});
    if(unavailable==='consent')h.settings({consent:false});
    if(unavailable==='empty-key')h.settings({apiKey:''});
    if(unavailable==='invalid-model')h.settings({model:{...h.context.model,name:''}});
    if(unavailable==='daily-cap')h.settings({dailyLimit:0});
    if(unavailable==='paused')h.context.collectionPaused.current=true;
    if(unavailable==='historical')h.context.config.current.historical=true;
    if(unavailable==='collection-disabled')h.context.config.current.auto=false;
    if(unavailable==='updating')h.settings({updating:true});
    await stabilize(h);h.advance(8000);await h.scan();
    expect(h.analyses).toHaveLength(0);expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.calls.some(call=>call.command==='score_candidates')).toBe(false);
  });

  it('requires two fresh stable scans for at least one second, then makes exactly one model request',async()=>{
    const h=harness({autoRecommend:true});
    await h.scan();h.advance(999);await h.scan();
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
    expect(modelPublications(h)).toHaveLength(0);expect(h.errors.some(error=>error.includes('synthetic model unavailable'))).toBe(true);
  });

  it('deduplicates a manual request before subsequent automatic scans',async()=>{
    const h=harness({autoRecommend:true}),task=h.context.run('recommend');await flush();
    await finish(h);await task;h.advance(9000);await stabilize(h);
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('enforces cooldown across changed candidate groups and then permits the new group',async()=>{
    const h=harness({autoRecommend:true});await stabilize(h);await finish(h);
    h.advance(1000);await h.scan(differentCandidates());h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(1);
    h.advance(7000);await h.scan();h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(2);await finish(h);
  });

  it('stops at the shared daily cap even if new candidate groups become stable',async()=>{
    const h=harness({autoRecommend:true,dailyLimit:1});await stabilize(h);await finish(h);
    h.advance(9000);await h.scan(differentCandidates());h.advance(1000);await h.scan();
    expect(h.analyses).toHaveLength(1);expect(h.context.bumpUsage).toHaveBeenCalledTimes(1);
  });

  it('limits automatic attempts to three groups in the same round',async()=>{
    const h=harness({autoRecommend:true});
    for(let group=1;group<=4;group++){
      h.advance(9000);await h.scan(differentCandidates(group));h.advance(1000);await h.scan();
      if(group<=3){expect(h.analyses).toHaveLength(group);await finish(h);}
    }
    expect(h.analyses).toHaveLength(3);expect(h.context.bumpUsage).toHaveBeenCalledTimes(3);
  });

  it.each(['miss','skip','changed','expired-gap'])('requires a new stable observation after %s',async invalidation=>{
    const h=harness({autoRecommend:true});await h.scan();h.advance(600);
    if(invalidation==='miss')await h.scan([]);
    if(invalidation==='skip')await h.scan([],{skipped:true,reason:'not-foreground'});
    if(invalidation==='changed')await h.scan(differentCandidates());
    if(invalidation==='expired-gap')h.advance(15000);
    h.advance(400);await h.scan(invalidation==='changed'?playing().candidates:h.context.current.current.candidates);
    h.advance(999);await h.scan();expect(h.analyses).toHaveLength(0);
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

  it.each(['auto-off','consent-revoked','model-changed','key-changed','updating','daily-cap','paused','disconnected'])('rechecks %s after retrieval and before billing',async change=>{
    const gate=deferred(),h=harness({autoRecommend:true,retrievalGate:gate});await stabilize(h);
    expect(h.calls.some(call=>call.command==='knowledge_retrieve')).toBe(true);expect(h.analyses).toHaveLength(0);
    if(change==='auto-off')h.settings({autoRecommend:false});
    if(change==='consent-revoked')h.settings({consent:false});
    if(change==='model-changed')h.settings({model:{...h.context.model,name:'another-offline-model'}});
    if(change==='key-changed')h.settings({apiKey:'another-fake-key'});
    if(change==='updating')h.settings({updating:true});
    if(change==='daily-cap')h.settings({dailyLimit:0});
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
