import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {applySnapshot, hasContent, newSession} from '../src/domain.ts';
import {readSession} from '../src/sessionReader.ts';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, nextTriggers, ownLevel} from '../src/level.ts';
import {AutoRecommendationGate} from '../src/autoRecommendation.ts';
import {KnowledgeWarmup} from '../src/knowledgeWarmup.ts';
import {collectorPollDelay} from '../src/collectorCadence.ts';
import {currentChoiceBand} from '../src/choiceContext.ts';

// Execute the real collection handler and its real IPC warmup initializer with
// synthetic snapshots only. Do not import main.tsx (which mounts the app), touch
// the user's knowledge tree, or permit a model/network call from this harness.
const file = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let poll, warmup;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'poll') poll = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'knowledgeWarmup') warmup = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
if (!poll || !warmup) throw new Error('Actual collection/warmup application handlers not found');
const compile = text => ts.transpileModule(text, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes;reject=no;});
  return {promise, resolve, reject};
};
async function flush() {for (let i=0;i<20;i++) await Promise.resolve();}
function snapshot(phase, gameId=null) {
  return {platformSupported:true, connection:'connected', phase, gameId,
    liveData:phase==='InProgress'?{
      activePlayer:{riotId:'synthetic#1',level:3},
      events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]},
      allPlayers:[{riotId:'synthetic#1',championName:'Ahri',team:'ORDER',items:[]}],
      gameData:{gameTime:30,gameVersion:'26.20.1'},
    }:null,
    lcuSession:null,endOfGame:null,result:null,observedAt:new Date().toISOString(),warnings:[]};
}
function harness({prepare=()=>Promise.resolve({status:'ready'}),prepareOcr=()=>Promise.resolve({status:'ready'}),prepareOverlay=()=>Promise.resolve({status:'ready'}),restored=null}={}) {
  const pending=[], calls=[], errors=[];
  const context = vm.createContext({
    Date, Promise, KnowledgeWarmup, applySnapshot, hasContent, readSession, collectorPollDelay, currentChoiceBand,
    liveDetectionBand, augmentBand, ownLevel, nextTriggers,
    useRef:value=>({current:value}),
    isTauri:vi.fn(()=>true), collectionPaused:{current:false}, config:{current:{historical:false,lockfile:''}},
    reading:{current:false}, readingSince:{current:0}, epoch:{current:0}, pollSeq:{current:0},
    snapshotRef:{current:null},snapshotPollStartedAt:{current:0},openingOcrArmed:{current:''},ocrCadence:{current:{reset:vi.fn()}}, setSnapshot:vi.fn(), idleFailures:{current:0}, nextPoll:{current:0}, document:{hidden:false},
    current:{current:newSession()}, postgameRetries:{current:{observe:vi.fn()}}, analysisTarget:{current:null},
    autoRecommendationGate:{current:new AutoRecommendationGate()},lastAutoScan:{current:null},
    seenIds:{current:''},panelMisses:{current:0},trigger:{current:{matchId:'',fired:[]}},lastSaved:{current:Date.now()},
    save:vi.fn(async()=>{}),recoverPostgame:vi.fn(async()=>{}),detectAugments:vi.fn(),
    bumpUsage:vi.fn(()=>{throw new Error('Warmup must not consume model usage');}),
    setError:error=>errors.push(error),setDetection:vi.fn(),
    commit:session=>{context.current.current=session;},
    invoke:(command,args)=>{
      calls.push({command,args});
      if(command==='collector_snapshot') {
        if(!pending.length)throw new Error('Missing synthetic collector snapshot');
        return Promise.resolve(pending.shift());
      }
      if(command==='knowledge_warmup')return prepare();
      if(command==='ocr_warmup')return prepareOcr();
      if(command==='overlay_prepare')return prepareOverlay();
      if(command==='get_session_by_match')return Promise.resolve(restored);
      if(command==='overlay_close')return Promise.resolve();
      throw new Error(`Unexpected IPC; no actual app/model access is allowed: ${command}`);
    },
  });
  vm.runInContext(compile(`globalThis.knowledgeWarmup=${warmup.getText(ast)};\n${poll.getText(ast)}`), context);
  return {context,calls,errors,pending,
    collect:async snap=>{pending.push(snap);await context.poll();await flush();},
    warmups:()=>calls.filter(call=>call.command==='knowledge_warmup'),
  };
}

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-12T14:50:00Z'));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('actual collection-time knowledge warmup flow',()=>{
  it('keeps API-driven startup polling fast while hidden, even after a long idle period',async()=>{
    const h=harness();h.context.document.hidden=true;h.context.idleFailures.current=100;
    for(const phase of ['ReadyCheck','ChampSelect','GameStart','InProgress']){
      const snap={...snapshot(phase,phase==='ReadyCheck'||phase==='ChampSelect'?null:'1234'),connection:'lcu',liveData:null};
      await h.collect(snap);
      expect(h.context.nextPoll.current-Date.now()).toBe(1000);
    }
    expect(h.errors).toEqual([]);
    expect(h.context.current.current.players).toEqual([]);
    expect(h.context.current.current.timeline.map(entry=>entry.phase)).toEqual(['ChampSelect','GameStart','InProgress']);
    expect(h.context.detectAugments).not.toHaveBeenCalled();
    expect(liveDetectionBand(h.context.current.current,h.context.snapshotRef.current,false)).toBeNull();
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
  });

  it('starts first-round OCR from a real API event without waiting for level or allPlayers',async()=>{
    const h=harness();h.context.document.hidden=true;
    await h.collect(snapshot('ChampSelect'));
    const snap={...snapshot('InProgress','1234'),connection:'lcu-and-live',liveData:{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}}};
    await h.collect(snap);
    expect(h.context.current.current.players).toEqual([]);
    expect(h.context.current.current.liveData).toEqual(snap.liveData);
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(liveDetectionBand(h.context.current.current,snap,false)).toBe(1);
    expect(h.context.nextPoll.current-Date.now()).toBe(1000);
    expect(h.errors).toEqual([]);
  });

  it('does not invent the first round when attaching mid-game with neither time nor level',async()=>{
    const h=harness();await h.collect({...snapshot('InProgress','1234'),connection:'lcu',liveData:null});
    expect(h.context.detectAugments).not.toHaveBeenCalled();
    expect(h.context.bumpUsage).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });

  it('keeps polling through hours of loading and waits for an actual GameStart event',async()=>{
    const h=harness();await h.collect(snapshot('ChampSelect'));
    await h.collect(snapshot('GameStart','1234'));
    vi.setSystemTime(Date.now()+2*60*60*1000);
    for(let i=0;i<4;i++){
      await h.collect({...snapshot('InProgress','1234'),liveData:{gameData:{gameTime:0},events:{Events:[]}}});
      expect(h.context.nextPoll.current-Date.now()).toBe(1000);
      expect(h.context.detectAugments).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now()+1000);
    }
    await h.collect({...snapshot('InProgress','1234'),liveData:{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0.03}]}}});
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.current.current.ocrOpening.loadingObserved).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('does not treat restored loading history as a newly observed opening after restart',async()=>{
    const at=new Date(Date.now()-60*60*1000).toISOString();
    const restored={...newSession(),id:'old-session',matchId:'1234',phase:'InProgress',
      timeline:[{phase:'ChampSelect',at},{phase:'InProgress',at}],
      ocrOpening:{gameId:'1234',loadingObserved:true,advanced:false}};
    const h=harness({restored});
    await h.collect({...snapshot('InProgress','1234'),liveData:{events:{Events:[{EventID:0,EventName:'GameStart',EventTime:0}]}}});
    expect(h.context.current.current.id).toBe('old-session');
    expect(h.context.current.current.ocrOpening.loadingObserved).toBe(false);
    expect(h.context.detectAugments).not.toHaveBeenCalled();
    await h.collect({...snapshot('InProgress','1234'),liveData:{activePlayer:{level:11}}});
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.current.current.ocrOpening.advanced).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('reads an observed later level without requiring a player roster',async()=>{
    const h=harness();const snap={...snapshot('InProgress','1234'),connection:'lcu-and-live',liveData:{activePlayer:{level:11},gameData:{gameTime:500}}};
    await h.collect(snap);
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(liveDetectionBand(h.context.current.current,snap,false)).toBe(11);
    expect(h.errors).toEqual([]);
  });

  it('warms in ChampSelect and retains its loading transition before a game ID exists, without sending context',async()=>{
    const h=harness();
    await h.collect(snapshot('ChampSelect'));
    expect(h.warmups()).toEqual([{command:'knowledge_warmup',args:undefined}]);
    expect(h.calls.filter(call=>['ocr_warmup','overlay_prepare'].includes(call.command))).toEqual([
      {command:'ocr_warmup',args:undefined},{command:'overlay_prepare',args:undefined},
    ]);
    expect(h.context.recoverPostgame).toHaveBeenCalledTimes(1);
    expect(h.context.current.current.players).toHaveLength(0);
    expect(h.context.detectAugments).not.toHaveBeenCalled();
    expect(h.context.save).not.toHaveBeenCalled();
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
    expect(h.calls[0].command).toBe('collector_snapshot');
    expect(h.calls.map(call=>call.command).sort()).toEqual(['collector_snapshot','knowledge_warmup','ocr_warmup','overlay_close','overlay_prepare']);
    expect(h.context.current.current.timeline.at(-1).phase).toBe('ChampSelect');
    expect(h.context.nextPoll.current-Date.now()).toBe(1000);
  });

  it('does not make polling or the first eligible OCR wait for unresolved preparation',async()=>{
    const gate=deferred(),h=harness({prepare:()=>gate.promise});
    await h.collect(snapshot('ChampSelect'));
    expect(h.context.reading.current).toBe(false);
    await h.collect(snapshot('InProgress','1234'));
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.detectAugments.mock.calls[0][0].matchId).toBe('1234');
    expect(h.context.reading.current).toBe(false);
    expect(h.warmups()).toHaveLength(1);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
    gate.resolve({status:'ready'});await flush();
  });

  it('contains a rejected warmup and still starts OCR without retrying a model or charging usage',async()=>{
    const h=harness({prepare:()=>Promise.reject(new Error('synthetic knowledge failure'))});
    await h.collect(snapshot('InProgress','1234'));
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.reading.current).toBe(false);
    expect(h.warmups()).toHaveLength(1);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
    expect(h.calls.every(call=>['collector_snapshot','knowledge_warmup','ocr_warmup','overlay_prepare','get_session_by_match','overlay_close'].includes(call.command))).toBe(true);
  });

  it.each(['ocr','overlay'])('contains a failed %s preparation, retries once, and does not delay live scanning',async part=>{
    const prepare=vi.fn().mockRejectedValueOnce(Error('synthetic preparation failed')).mockResolvedValue({status:'ready'});
    const h=harness(part==='ocr'?{prepareOcr:prepare}:{prepareOverlay:prepare});
    await h.collect(snapshot('ChampSelect'));
    expect(prepare).toHaveBeenCalledTimes(1);
    await h.collect(snapshot('GameStart','1234'));
    expect(prepare).toHaveBeenCalledTimes(2);
    await h.collect(snapshot('InProgress','1234'));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('deduplicates repeated loading snapshots and a later game ID, then warms the next exact match',async()=>{
    const h=harness();
    for(const snap of [snapshot('ChampSelect'),snapshot('ChampSelect'),snapshot('GameStart','1234'),snapshot('InProgress','1234'),snapshot('InProgress','1234')])await h.collect(snap);
    expect(h.warmups()).toHaveLength(1);
    await h.collect(snapshot('InProgress','5678'));
    expect(h.warmups()).toHaveLength(2);
    await h.collect(snapshot('EndOfGame','5678'));
    await h.collect(snapshot('ChampSelect'));
    expect(h.warmups()).toHaveLength(3);
    expect(h.warmups().every(call=>call.args===undefined)).toBe(true);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it('ignores an obsolete collector response before it can trigger warmup',async()=>{
    const gate=deferred(),h=harness();
    h.pending.push(gate.promise);
    const collecting=h.context.poll();
    h.context.epoch.current++;
    gate.resolve(snapshot('ChampSelect'));
    await collecting;await flush();
    expect(h.warmups()).toHaveLength(0);
    expect(h.context.setSnapshot).not.toHaveBeenCalled();
    expect(h.context.detectAugments).not.toHaveBeenCalled();
    expect(h.context.reading.current).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it.each(['historical','paused','browser'])('does not prepare through a disabled collector (%s)',async reason=>{
    const h=harness();
    if(reason==='historical')h.context.config.current.historical=true;
    if(reason==='paused')h.context.collectionPaused.current=true;
    if(reason==='browser')h.context.isTauri.mockReturnValue(false);
    await h.context.poll();await flush();
    expect(h.calls).toEqual([]);
    expect(h.context.bumpUsage).not.toHaveBeenCalled();
  });

  it('registers the local-only command and starts native preparation beside existing OCR warmup',()=>{
    const native=fs.readFileSync(new URL('../src-tauri/src/main.rs',import.meta.url),'utf8');
    expect(native).toMatch(/\.setup\([\s\S]*knowledge::start_warmup\(app\.handle\(\)\)/);
    expect(native).toContain('ocr::start_warmup(app.handle());');
    expect(native).toMatch(/\.invoke_handler\(tauri::generate_handler!\[[\s\S]*knowledge::knowledge_warmup,/);
    expect(native).toContain('ocr::ocr_warmup,');
    expect(native).toContain('overlay::overlay_prepare,');
  });

  it('keeps native startup and loading-triggered disk/index preparation off asynchronous workers',()=>{
    const knowledge=fs.readFileSync(new URL('../src-tauri/src/knowledge.rs',import.meta.url),'utf8');
    const startup=knowledge.match(/pub fn start_warmup\([^]*?\n\}/)?.[0];
    const command=knowledge.match(/pub async fn knowledge_warmup\([^]*?\n\}/)?.[0];
    expect(startup).toBeDefined();expect(command).toBeDefined();
    expect(startup).toMatch(/tauri::async_runtime::spawn_blocking\(move\s*\|\|\s*\{[^]*run_warmup\(&app\)/);
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\(move\s*\|\|\s*run_warmup\(&app\)\)\s*\.await/);
  });
});
