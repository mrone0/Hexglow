import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {applySnapshot, hasContent, newSession} from '../src/domain.ts';
import {liveDetectionBand} from '../src/detectionGate.ts';
import {augmentBand, nextTriggers, ownLevel} from '../src/level.ts';
import {canRecoverPostgame, hasMissingPostgameEvidence, mergePostgameEvidence, PostgameRetryQueue} from '../src/postgameRecovery.ts';
import {SaveQueue} from '../src/saveQueue.ts';
import {readSession} from '../src/sessionReader.ts';

// Extract the actual application callbacks: a parallel implementation of the
// recovery protocol would not catch accidental await/guard/rebase regressions.
const mainPath = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(mainPath, 'utf8');
const ast = ts.createSourceFile(mainPath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extracted = new Map();
const callbackNames = ['recoverPostgame', 'poll', 'save', 'rescanArchive', 'openArchive', 'patch', 'beginMutation', 'endMutation'];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && callbackNames.includes(node.name?.text)) extracted.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of callbackNames) {
  if (!extracted.has(name)) throw new Error(`Application callback not found: ${name}`);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

function ended() {
  return {...newSession(), id: 'old-session', matchId: '100', phase: 'EndOfGame', archived: true,
    endedAt: new Date(Date.now() - 10000).toISOString(), ownPlayerId: 'me#1', notes: 'original note',
    players: [{id: 'me#1', name: 'me#1', champion: 'Ahri', team: 'ORDER', items: [], augments: [], augmentsConfirmed: false}]};
}
function evidence() {
  const observedAt = new Date().toISOString();
  return {gameId: '100', observedAt, players: [{key: 'me#1', champion: 'Ahri', team: 'ORDER', augments: ['verified augment']}],
    endOfGame: {gameId: 100}, result: {gameId: '100', status: 'win', source: 'lcu-history', observedAt}};
}
function snapshot(phase = 'Lobby', gameId = null) {
  return {platformSupported: true, connection: 'connected', phase, gameId, observedAt: new Date().toISOString(),
    liveData: phase === 'InProgress' ? {activePlayer: {riotId: 'me#1', level: 3},
      allPlayers: [{riotId: 'me#1', championName: 'Ahri', team: 'ORDER', items: []}], gameData: {gameTime: 5}} : null,
    lcuSession: null, endOfGame: null, result: null, warnings: []};
}
function decision() {
  return {at: new Date().toISOString(), context: {players: [], candidates: []},
    result: {summary: 'analysis completed while waiting', ranking: [], missingInformation: []}};
}

function harness({target = ended(), current = target} = {}) {
  const database = new Map([[target.id, structuredClone(target)]]);
  const requests = [], writes = [], reads = [], errors = [], commits = [], collectorReplies = [];
  const retries = new PostgameRetryQueue();
  retries.observe(target, Date.now() - 4000);
  const context = vm.createContext({
    Date, Promise, structuredClone, clearTimeout, setTimeout,
    canRecoverPostgame, hasMissingPostgameEvidence, mergePostgameEvidence, readSession, applySnapshot, hasContent, liveDetectionBand,
    augmentBand, nextTriggers, ownLevel,
    current: {current}, activeSession: {current: null}, archiveDetailRef: {current: null}, archiveDetail: null,
    analysisTarget: {current: {observe: vi.fn()}}, postgameRetries: {current: retries},
    recoveringPostgame: {current: false}, epoch: {current: 0}, collectionPaused: {current: false}, busyRef: {current: false},
    snapshotRef: {current: snapshot()}, config: {current: {lockfile: '', historical: false, view: 'live'}},
    writeQueue: {current: Promise.resolve()}, lastSaved: {current: Date.now()}, debounce: {current: null},
    reading: {current: false}, readingSince: {current: 0}, pollSeq: {current: 0},
    idleFailures: {current: 0}, nextPoll: {current: 0}, seenIds: {current: ''}, panelMisses: {current: 0},
    trigger: {current: {matchId: '', fired: []}}, document: {hidden: false},
    isTauri: () => true, setSnapshot: vi.fn(), setSaved: vi.fn(), setBusy: vi.fn(), refreshHistory: async () => [],
    detectAugments: vi.fn(), setError: error => errors.push(error),
    commit: session => { context.postgameRetries.current.observe(session); context.current.current = session; commits.push(session); },
    setArchiveDetail: update => { context.archiveDetailRef.current = typeof update === 'function' ? update(context.archiveDetailRef.current) : update; context.archiveDetail = context.archiveDetailRef.current; },
    invoke: async (command, args) => {
      if (command === 'postgame_rescan') { const task = deferred(); requests.push({args, ...task}); return task.promise; }
      if (command === 'get_session') {
        reads.push(args.id);
        if (!database.has(args.id)) throw new Error('record does not exist');
        return structuredClone(database.get(args.id));
      }
      if (command === 'save_session') { const saved = structuredClone(args.session); writes.push(saved); database.set(saved.id, saved); return; }
      if (command === 'collector_snapshot') {
        if (!collectorReplies.length) throw new Error('No synthetic collector snapshot queued');
        return collectorReplies.shift();
      }
      if (command === 'get_session_by_match') return null;
      if (command === 'overlay_close') return;
      throw new Error(`Unexpected IPC: ${command}`);
    },
  });
  context.saver = {current: new SaveQueue(value => context.invoke('save_session', {session: value}))};
  for (const name of callbackNames) {
    vm.runInContext(ts.transpileModule(extracted.get(name).getText(ast), {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    }).outputText, context);
  }
  return {context, target, database, requests, writes, reads, errors, commits, collectorReplies,
    recover: () => context.recoverPostgame(context.epoch.current)};
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T08:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('application postgame recovery callbacks', () => {
  it('never awaits background recovery on either collector polling path', () => {
    const calls = [];
    function scan(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'recoverPostgame') calls.push(node);
      ts.forEachChild(node, scan);
    }
    scan(extracted.get('poll'));
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(ts.isVoidExpression(call.parent)).toBe(true);
  });

  it('keeps collector/OCR available when a lobby recovery reply is still pending', async () => {
    const h = harness({current: {...newSession(), id: 'empty'}});
    h.collectorReplies.push(snapshot());
    await h.context.poll(); await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.context.recoveringPostgame.current).toBe(true);
    expect(h.context.reading.current).toBe(false);

    h.collectorReplies.push(snapshot('InProgress', '101'));
    await h.context.poll(); await flush();
    expect(h.context.current.current.matchId).toBe('101');
    expect(h.context.detectAugments).toHaveBeenCalledTimes(1);
    expect(h.context.detectAugments.mock.calls[0][0].matchId).toBe('101');
    expect(h.requests).toHaveLength(1);

    h.requests[0].resolve(evidence()); await flush();
    expect(h.context.current.current.matchId).toBe('101');
    expect(h.database.get('old-session').result.status).toBe('win');
    expect(h.errors).toEqual([]);
  });

  it('rebases on latest current-session notes, selections and completed decisions', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    const newer = {...h.target, notes: 'edited during request', decisions: [decision()],
      players: h.target.players.map(player => ({...player, augments: ['manual choice']}))};
    h.context.current.current = newer;
    h.requests[0].resolve(evidence()); await task;
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({notes: newer.notes, decisions: newer.decisions, result: {status: 'win'}});
    expect(h.writes[0].players[0].augments).toEqual(['manual choice', 'verified augment']);
    expect(h.context.analysisTarget.current.observe).toHaveBeenCalledWith(h.context.current.current);
  });

  it('reloads the archived base after a late reply without replacing the new live match', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    const live = {...newSession(), id: 'new-session', matchId: '101', phase: 'InProgress', notes: 'new match note'};
    h.context.current.current = live;
    h.context.snapshotRef.current = snapshot('InProgress', '101');
    h.database.set(h.target.id, {...h.target, notes: 'latest archived note', decisions: [decision()]});
    h.requests[0].resolve(evidence()); await task;
    expect(h.context.current.current).toBe(live);
    expect(h.commits).toEqual([]);
    expect(h.reads).toEqual([h.target.id, h.target.id]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({id: h.target.id, matchId: '100', notes: 'latest archived note'});
    expect(h.writes[0].decisions).toHaveLength(1);
    expect(h.writes[0].result.status).toBe('win');
  });

  it('waits for in-flight saves before reading the final merge base', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    const idle = deferred();
    h.context.saver.current.idle = () => idle.promise;
    h.requests[0].resolve(evidence()); await flush();
    expect(h.writes).toEqual([]);
    h.context.current.current = {...h.target, notes: 'last queued write', decisions: [decision()]};
    idle.resolve(); await task;
    expect(h.writes[0]).toMatchObject({notes: 'last queued write', decisions: [decision()]});
  });

  it.each(['delete', 'exit', 'analysis'])('rejects a late reply after %s invalidates the epoch', async operation => {
    const h = harness();
    const task = h.recover(); await flush();
    h.context.epoch.current++;
    h.context.busyRef.current = true;
    h.context.collectionPaused.current = operation !== 'analysis';
    if (operation === 'delete') {
      h.database.delete(h.target.id);
      h.context.postgameRetries.current.forget(h.target.id);
      h.context.current.current = {...newSession(), id: 'replacement'};
    }
    const current = h.context.current.current;
    h.requests[0].resolve(evidence()); await task;
    expect(h.writes).toEqual([]);
    expect(h.commits).toEqual([]);
    expect(h.context.current.current).toBe(current);
    expect(h.context.busyRef.current).toBe(true);
    expect(h.context.recoveringPostgame.current).toBe(false);
    if (operation === 'delete') expect(h.database.has(h.target.id)).toBe(false);
  });

  it('checks epoch again after waiting for the post-request save queue', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    const idle = deferred();
    h.context.saver.current.idle = () => idle.promise;
    h.requests[0].resolve(evidence()); await flush();
    h.context.epoch.current++;
    idle.resolve(); await task;
    expect(h.writes).toEqual([]);
    expect(h.commits).toEqual([]);
  });

  it('rejects evidence if the same session ID has been rebound to another match', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    h.context.current.current = {...h.target, matchId: '101'};
    h.requests[0].resolve(evidence()); await task;
    expect(h.writes).toEqual([]);
    expect(h.context.current.current.result.status).toBe('unknown');
  });

  it.each(['InProgress', 'ChampSelect', 'GameStart', 'Reconnect'])('does not start recovery during %s', async phase => {
    const h = harness();
    h.context.snapshotRef.current = snapshot(phase, '101');
    await h.recover();
    expect(h.requests).toEqual([]);
    expect(h.context.recoveringPostgame.current).toBe(false);
    h.context.snapshotRef.current = snapshot();
    const task = h.recover(); await flush();
    expect(h.requests).toHaveLength(1); // The skipped phase did not consume the retry.
    h.requests[0].resolve(null); await task;
  });

  it('allows only one pending request and releases single-flight after a failure', async () => {
    const h = harness();
    const first = h.recover(); await flush();
    await h.recover();
    expect(h.requests).toHaveLength(1);
    h.requests[0].reject(new Error('client temporarily unavailable')); await first;
    expect(h.context.recoveringPostgame.current).toBe(false);
    expect(h.errors).toHaveLength(1);
    expect(h.writes).toHaveLength(1); // Read failure does not block durability of the latest base.
    vi.advanceTimersByTime(6000);
    const second = h.recover(); await flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(evidence()); await second;
    expect(h.writes).toHaveLength(2);
    expect(h.context.recoveringPostgame.current).toBe(false);
  });

  it('suppresses stale errors after cancellation and cannot leave recovery locked', async () => {
    const h = harness();
    const task = h.recover(); await flush();
    h.context.epoch.current++;
    h.requests[0].reject(new Error('late obsolete failure')); await task;
    expect(h.errors).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.context.recoveringPostgame.current).toBe(false);
  });

  it('reads an old match from storage instead of overwriting it with stale detail/held caches', async () => {
    const h = harness({current: {...newSession(), id: 'new-session', matchId: '101'}});
    h.context.archiveDetailRef.current = {...h.target, notes: 'stale detail', sampleCount: 10};
    h.context.activeSession.current = {...h.target, notes: 'stale held snapshot', sampleCount: 12};
    h.database.set(h.target.id, {...h.target, notes: 'final saved notes', sampleCount: 30, decisions: [decision()]});
    const task = h.recover(); await flush();
    expect(h.requests[0].args.session).toMatchObject({notes: 'final saved notes', sampleCount: 30});
    h.requests[0].resolve(evidence()); await task;
    expect(h.database.get(h.target.id)).toMatchObject({notes: 'final saved notes', sampleCount: 30, result: {status: 'win'}});
    expect(h.database.get(h.target.id).decisions).toHaveLength(1);
    expect(h.context.archiveDetailRef.current.sampleCount).toBe(30);
    expect(h.context.activeSession.current.sampleCount).toBe(30);
  });

  it('keeps a failed save queued and does not publish an unpersisted complete result', async () => {
    const h = harness();
    const originalInvoke = h.context.invoke;
    let failures = 1;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && failures-- > 0) throw new Error('synthetic disk failure');
      return originalInvoke(command, args);
    };
    const first = h.recover(); await flush();
    h.requests[0].resolve(evidence()); await first;
    expect(h.context.current.current).toBe(h.target);
    expect(h.commits).toEqual([]);
    expect(h.database.get(h.target.id).result.status).toBe('unknown');
    expect(h.errors[0]).toContain('synthetic disk failure');

    vi.advanceTimersByTime(6000);
    const second = h.recover(); await flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(evidence()); await second;
    expect(h.database.get(h.target.id).result.status).toBe('win');
    expect(h.commits).toHaveLength(1);
    expect(h.context.postgameRetries.current.take(Date.now() + 60000)?.id).toBe(h.target.id);
  });

  it('persists an unchanged current snapshot after a failed save and keeps bounded collection alive', async () => {
    const target = ended();
    const completed = mergePostgameEvidence(target, evidence());
    const h = harness({target, current: completed});
    const originalInvoke = h.context.invoke;
    const firstWrite = deferred();
    let first = true;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && first) { first = false; await firstWrite.promise; }
      return originalInvoke(command, args);
    };
    const firstTask = h.recover(); await flush();
    expect(h.requests).toHaveLength(1);
    h.requests[0].resolve(evidence()); await flush();
    expect(h.database.get(target.id).result.status).toBe('unknown');
    firstWrite.reject(new Error('first complete snapshot did not save')); await firstTask;
    expect(h.database.get(target.id).result.status).toBe('unknown');
    vi.advanceTimersByTime(6000);
    const retry = h.recover(); await flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(null); await retry;
    expect(h.database.get(target.id).result.status).toBe('win');
    expect(h.context.postgameRetries.current.take(Date.now() + 60000)?.id).toBe(h.target.id);
  });

  it('collects later fragments after every player is confirmed, then stops at eight background attempts', async () => {
    const h = harness();
    for (let pass = 0; pass < 10; pass++) {
      if (pass) vi.advanceTimersByTime(60000);
      const before = h.requests.length;
      const task = h.recover(); await flush();
      if (h.requests.length > before) {
        const payload = evidence();
        payload.players[0].augments = pass === 0 ? ['first fragment'] : ['second fragment'];
        h.requests.at(-1).resolve(payload);
      }
      await task;
    }
    expect(h.requests).toHaveLength(8);
    expect(h.writes).toHaveLength(8);
    expect(h.database.get(h.target.id).players[0]).toMatchObject({
      augments: ['first fragment', 'second fragment'], augmentsConfirmed: true,
    });
    expect(h.database.get(h.target.id).result.status).toBe('win');
    expect(h.context.recoveringPostgame.current).toBe(false);
  });

  it('saves previously acquired evidence even if the next client read fails, reporting errors only after durability', async () => {
    const target = ended();
    const current = mergePostgameEvidence(target, evidence());
    const h = harness({target, current});
    const originalInvoke = h.context.invoke;
    const disk = deferred();
    h.context.invoke = async (command, args) => {
      if (command === 'save_session') await disk.promise;
      return originalInvoke(command, args);
    };
    const task = h.recover(); await flush();
    h.requests[0].reject(new Error('read unavailable')); await flush();
    expect(h.database.get(target.id).result.status).toBe('unknown');
    expect(h.errors).toEqual([]);
    expect(h.commits).toEqual([]);
    disk.resolve(); await task;
    expect(h.database.get(target.id).result.status).toBe('win');
    expect(h.context.current.current.players[0].augments).toEqual(['verified augment']);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('read unavailable');
    expect(h.context.postgameRetries.current.take(Date.now() + 6000)?.id).toBe(target.id);
  });

  it('prioritizes a save failure over the client read error without publishing unpersisted evidence', async () => {
    const target = ended();
    const h = harness({target, current: mergePostgameEvidence(target, evidence())});
    const originalInvoke = h.context.invoke;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session') throw new Error('durability failed');
      return originalInvoke(command, args);
    };
    const task = h.recover(); await flush();
    h.requests[0].reject(new Error('read unavailable')); await task;
    expect(h.database.get(target.id).result.status).toBe('unknown');
    expect(h.commits).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain('durability failed');
  });

  it('opening an old archive without known gaps does not restart background collection or issue a rescan', async () => {
    const target = {...mergePostgameEvidence(ended(), evidence()), endedAt: new Date(Date.now() - 1200000).toISOString()};
    const h = harness({target, current: newSession()});
    await h.context.openArchive(target.id);
    expect(h.requests).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.context.archiveDetail.players[0].augments).toEqual(['verified augment']);
    expect(h.context.postgameRetries.current.take(Date.now() + 3000)).toBeNull();
  });

  it('rebases again if notes or queued collector writes change while the recovered save is pending', async () => {
    const h = harness();
    const originalInvoke = h.context.invoke;
    const firstWrite = deferred();
    let first = true;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && first) { first = false; await firstWrite.promise; }
      return originalInvoke(command, args);
    };
    const task = h.recover(); await flush();
    h.requests[0].resolve(evidence()); await flush();
    expect(h.commits).toEqual([]);
    const newer = {...h.target, notes: 'edit during disk wait', sampleCount: 31, decisions: [decision()]};
    h.context.current.current = newer;
    const queued = h.context.save(newer);
    firstWrite.resolve(); await queued; await task;
    expect(h.context.current.current).toMatchObject({notes: newer.notes, sampleCount: 31, result: {status: 'win'}});
    expect(h.context.current.current.decisions).toHaveLength(1);
    expect(h.database.get(h.target.id)).toMatchObject({notes: newer.notes, sampleCount: 31, result: {status: 'win'}});
    expect(h.commits).toHaveLength(1);
  });

  it('rechecks an old match after a queued final archive write lands behind the recovery save', async () => {
    const h = harness({current: {...newSession(), id: 'new-session', matchId: '101'}});
    const originalInvoke = h.context.invoke;
    const firstWrite = deferred();
    let first = true;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && first) { first = false; await firstWrite.promise; }
      return originalInvoke(command, args);
    };
    const task = h.recover(); await flush();
    h.requests[0].resolve(evidence()); await flush();
    const queued = h.context.save({...h.target, sampleCount: 35, notes: 'final archive write'});
    firstWrite.resolve(); await queued; await task;
    expect(h.database.get(h.target.id)).toMatchObject({notes: 'final archive write', sampleCount: 35, result: {status: 'win'}});
    expect(h.context.current.current.matchId).toBe('101');
  });

  it('does not commit or finish a retry when a mutation starts during its save wait', async () => {
    const h = harness();
    const originalInvoke = h.context.invoke;
    const disk = deferred();
    h.context.invoke = async (command, args) => {
      if (command === 'save_session') await disk.promise;
      return originalInvoke(command, args);
    };
    const task = h.recover(); await flush();
    h.requests[0].resolve(evidence()); await flush();
    h.context.beginMutation();
    disk.resolve(); await task;
    expect(h.commits).toEqual([]);
    expect(h.context.busyRef.current).toBe(true);
    expect(h.context.postgameRetries.current.take(Date.now() + 6000)?.id).toBe(h.target.id);
  });

  it('manual rescan waits for storage and loads an old match without trusting its detail cache', async () => {
    const h = harness({current: {...newSession(), id: 'new-session', matchId: '101'}});
    h.context.archiveDetail = h.context.archiveDetailRef.current = {...h.target, sampleCount: 10};
    const idle = deferred();
    h.context.saver.current.idle = () => idle.promise;
    const task = h.context.rescanArchive(); await flush();
    expect(h.requests).toEqual([]);
    h.database.set(h.target.id, {...h.target, sampleCount: 30, notes: 'latest saved note'});
    idle.resolve(); await flush();
    expect(h.requests[0].args.session).toMatchObject({sampleCount: 30, notes: 'latest saved note'});
    h.requests[0].resolve(evidence()); await task;
    expect(h.database.get(h.target.id)).toMatchObject({sampleCount: 30, notes: 'latest saved note', result: {status: 'win'}});
    expect(h.context.archiveDetail.sampleCount).toBe(30);
    expect(h.context.busyRef.current).toBe(false);
  });

  it('manual rescan does not publish completion or remove the queued retry on save failure', async () => {
    const h = harness({current: {...newSession(), id: 'new-session', matchId: '101'}});
    h.context.archiveDetail = h.context.archiveDetailRef.current = h.target;
    const originalInvoke = h.context.invoke;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session') throw new Error('manual save failed');
      return originalInvoke(command, args);
    };
    const task = h.context.rescanArchive(); await flush();
    h.requests[0].resolve(evidence()); await task;
    expect(h.context.archiveDetail).toBe(h.target);
    expect(h.database.get(h.target.id).result.status).toBe('unknown');
    expect(h.context.postgameRetries.current.take(Date.now() + 6000)?.id).toBe(h.target.id);
    expect(h.context.busyRef.current).toBe(false);
  });

  it('opening an archive does not publish or complete recovery until its save succeeds', async () => {
    const h = harness();
    const originalInvoke = h.context.invoke;
    let saves = 0;
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && ++saves === 2) throw new Error('archive recovered save failed');
      return originalInvoke(command, args);
    };
    const task = h.context.openArchive(h.target.id); await flush();
    h.requests[0].resolve(evidence());
    await expect(task).rejects.toThrow('archive recovered save failed');
    expect(h.context.current.current).toBe(h.target);
    expect(h.commits).toEqual([]);
    expect(h.context.archiveDetail).toBeNull();
    expect(h.database.get(h.target.id).result.status).toBe('unknown');
    expect(h.context.postgameRetries.current.take(Date.now() + 6000)?.id).toBe(h.target.id);
    expect(h.context.busyRef.current).toBe(false);
  });

  it('opening an archive publishes a successfully saved recovery to current and detail views', async () => {
    const h = harness();
    const task = h.context.openArchive(h.target.id); await flush();
    h.requests[0].resolve(evidence()); await task;
    expect(h.database.get(h.target.id).result.status).toBe('win');
    expect(h.context.current.current.result.status).toBe('win');
    expect(h.context.archiveDetail.result.status).toBe('win');
    expect(h.context.postgameRetries.current.take(Date.now() + 6000)?.id).toBe(h.target.id);
    expect(h.context.busyRef.current).toBe(false);
  });

  it('manual rescan flushes a pending note debounce so it cannot overwrite the recovered save', async () => {
    const h = harness();
    h.context.archiveDetail = h.context.archiveDetailRef.current = h.target;
    h.context.patch({notes: 'pending local note'});
    const originalInvoke = h.context.invoke;
    const recoveredWrite = deferred();
    h.context.invoke = async (command, args) => {
      if (command === 'save_session' && args.session.result?.status === 'win') await recoveredWrite.promise;
      return originalInvoke(command, args);
    };
    const task = h.context.rescanArchive(); await flush();
    h.requests[0].resolve(evidence()); await flush();
    vi.advanceTimersByTime(1500); await flush();
    recoveredWrite.resolve(); await task; await h.context.saver.current.idle();
    expect(h.database.get(h.target.id)).toMatchObject({notes: 'pending local note', result: {status: 'win'}});
    expect(h.context.current.current.result.status).toBe('win');
    expect(h.context.debounce.current).toBeNull();
  });
});
