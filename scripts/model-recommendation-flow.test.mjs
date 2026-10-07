import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {newSession, hasContent, synchronizeSelections} from '../src/domain.ts';
import {AnalysisTarget} from '../src/analysis.ts';
import {analysisSource} from '../src/analysisGate.ts';
import {liveOverviewState} from '../src/LiveOverview.tsx';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, ownLevel} from '../src/level.ts';
import {markCandidateEdits, mergeDetectedCandidates} from '../src/candidates.ts';
import {SaveQueue} from '../src/saveQueue.ts';
import {createLocalRecommendation, localRecommendationKey, recognizedCandidates, modelRecommendation, selectLocalRecommendation} from '../src/liveRecommendation.ts';
import {canPublishModelRecommendation, modelContextKey} from '../src/modelPublication.ts';

// Run the actual application handlers with synthetic state/IPC only. Importing
// main.tsx would mount the desktop app and is intentionally never done here.
const file = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let detector, restored, knowledgeChanged;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['run','patch','save'].includes(node.name?.text)) callbacks.set(node.name.text,node);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'detectAugments') detector = node.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements.some(element => element.getText(ast) === 'localScoreKey')) restored = node.arguments[0];
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'KnowledgePanel') knowledgeChanged = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onChanged')?.initializer?.expression;
  ts.forEachChild(node,visit);
}
visit(ast);
if (callbacks.size !== 3 || !detector || !restored || !knowledgeChanged) throw new Error('Actual model/recognition application handlers not found');
const compile = text => ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function flush(){for(let n=0;n<40;n++)await Promise.resolve();}

function playing(){
  return {...newSession(),id:'synthetic-session',matchId:'1234',phase:'InProgress',candidateBand:1,ownPlayerId:'synthetic#1',
    players:[{id:'synthetic#1',name:'synthetic',champion:'Ekko',team:'ORDER',items:[],augments:[],augmentsConfirmed:true}],
    candidates:[1,2,3].map(id=>({id:String(id),name:`candidate ${id}`,description:`complete effect ${id}`,source:'ocr'})),
    liveData:{activePlayer:{riotId:'synthetic#1',level:3},gameData:{gameTime:70},allPlayers:[]}};
}
function modelResult(session){return {summary:'synthetic model comparison',missingInformation:[],
  engine:{provider:'mock',model:'offline-only',latencyMs:1,confidenceKind:'model',scoringMode:'dynamic-model-v1'},
  ranking:session.candidates.map((candidate,index)=>({candidateId:candidate.id,score:80-index*10,confidence:0.8,reason:'synthetic reason',evidence:['synthetic source'],risks:[]}))};}

function harness({session=playing(),saveGate=null,retrievalGate=null}={}){
  const calls=[],errors=[],writes=[],trace=[],analyses=[],scans=[];
  const context=vm.createContext({Date,Promise,structuredClone,setTimeout,clearTimeout,
    AnalysisTarget,analysisSource,liveOverviewState,liveDetectionBand,augmentBand,ownLevel,
    markCandidateEdits,mergeDetectedCandidates,synchronizeSelections,hasContent,
    createLocalRecommendation,localRecommendationKey,recognizedCandidates,modelRecommendation,selectLocalRecommendation,
    canPublishModelRecommendation,modelContextKey,
    current:{current:session},session,snapshotRef:{current:{connection:'connected',phase:'InProgress',gameId:session.matchId,liveData:session.liveData}},
    config:{current:{historical:false,view:'live'}},historical:false,epoch:{current:0},busyRef:{current:false},
    analysisTarget:{current:null},knowledgeRevision:{current:0},lastRun:{current:0},COOLDOWN_MS:8000,dailyLimit:20,
    consent:true,model:{provider:'openai',name:'offline-only',baseUrl:'https://invalid.example'},apiKey:'not-a-real-key',
    scanning:{current:false},seenMatch:{current:session.id},seenIds:{current:''},candidateRevision:{current:0},panelMisses:{current:0},
    debounce:{current:null},writeQueue:{current:Promise.resolve()},lastSaved:{current:0},
    localRecommendation:null,localRecommendationRef:{current:null},
    isTauri:()=>true,readUsage:()=>({count:0}),bumpUsage:vi.fn(()=>1),modelServiceLabel:()=> 'offline test',
    setView:vi.fn(),setBusy:vi.fn(),setDailyUsed:vi.fn(),setFlash:vi.fn(),setSaved:vi.fn(),setKnowledge:vi.fn(),setSimilar:vi.fn(),setDetection:vi.fn(),refreshHistory:async()=>[],
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
      if(command==='overlay_publish'){trace.push(['publish',args.payload.ranking.source]);return;}
      if(command==='overlay_open'||command==='overlay_close'){trace.push([command]);return;}
      throw new Error(`Unexpected IPC (no real API is allowed): ${command}`);
    },
  });
  context.saver={current:new SaveQueue(value=>context.invoke('save_session',{session:value}))};
  for(const callback of callbacks.values())vm.runInContext(compile(callback.getText(ast)),context);
  vm.runInContext(compile(`globalThis.detectAugments=${detector.getText(ast)};globalThis.restored=${restored.getText(ast)};globalThis.knowledgeChanged=${knowledgeChanged.getText(ast)};`),context);
  return {context,calls,errors,writes,trace,analyses,scans,
    publications:()=>calls.filter(call=>call.command==='overlay_publish'),
    scan:async(candidates=session.candidates)=>{scans.push({candidates,source:'synthetic',elapsedMs:1,model:'offline'});context.detectAugments(context.current.current);await flush();},
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
