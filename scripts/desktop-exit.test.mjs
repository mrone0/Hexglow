import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Exercise the handlers wired into the application, not a second implementation
// of its exit protocol. Keep the real save() and SaveQueue in the regression.
const mainPath = new URL('../src/main.tsx', import.meta.url);
const source = fs.readFileSync(mainPath, 'utf8');
const ast = ts.createSourceFile(mainPath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extracted = new Map();
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button' && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'className' && attribute.initializer?.text === 'rail-exit')) extracted.set('exit-button', node);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'save') extracted.set('save', node);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'listen' && ts.isStringLiteral(node.arguments[0])) {
    const event = node.arguments[0].text;
    if (event === 'app:before-exit' || event === 'app:exit-error') extracted.set(event, node.arguments[1]);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of ['save', 'app:before-exit', 'app:exit-error', 'exit-button']) {
  if (!extracted.has(name)) throw new Error(`Application exit handler not found: ${name}`);
}
const queueSource = fs.readFileSync(new URL('../src/saveQueue.ts', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

function harness({archive = false, keyGate = null} = {}) {
  const writes = [], history = [], acks = [], exits = [], errors = [], heldReplies = new Map();
  let nativePending = null;
  const context = vm.createContext({
    exports: {}, setTimeout, clearTimeout, structuredClone, Date, Promise,
    exitPending: {current: null}, lastExitRequest: {current: 0}, busyRef: {current: false}, knowledgeLeaveGuard: {current: null},
    collectionPaused: {current: false}, epoch: {current: 0}, debounce: {current: null},
    modelKeys: {current: {flush: () => keyGate ? keyGate.promise : Promise.resolve()}},
    current: {current: {id: 'synthetic-session', notes: 'test snapshot'}},
    writeQueue: {current: Promise.resolve()}, lastSaved: {current: 0}, config: {current: {view: archive ? 'archive' : 'live'}},
    hasContent: () => true, setSaved: () => {}, setBusy: () => {}, setError: error => errors.push(error),
    refreshHistory: () => { const task = deferred(); history.push(task); return task.promise; },
    invoke: async (command, args) => {
      if (command === 'save_session') { const task = deferred(); writes.push(task); return task.promise; }
      if (command !== 'desktop_exit_ready') throw new Error(`Unexpected IPC: ${command}`);
      acks.push(args);
      // Match desktop.rs: only the active native request may cancel or exit.
      if (args.error) {
        if (nativePending === args.requestId) {
          nativePending = null;
          context.failed({payload: {requestId: args.requestId, message: args.error}});
        }
        return;
      }
      if (heldReplies.has(args.requestId)) return heldReplies.get(args.requestId).promise;
      if (nativePending !== args.requestId) throw new Error('本次退出已取消，请重新选择退出 Hexglow');
      exits.push(args.requestId);
      nativePending = null;
    },
  });
  const run = text => vm.runInContext(ts.transpileModule(text, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText, context);
  run(queueSource);
  context.saver = {current: new context.exports.SaveQueue(value => context.invoke('save_session', {session: value}))};
  run(extracted.get('save').getText(ast));
  run(`globalThis.before = (${extracted.get('app:before-exit').getText(ast)});`);
  run(`globalThis.failed = (${extracted.get('app:exit-error').getText(ast)});`);
  return {
    context, writes, history, acks, exits, errors,
    holdReply(requestId) { const reply = deferred(); heldReplies.set(requestId, reply); return reply; },
    begin(requestId) { nativePending = requestId; context.before({payload: {requestId}}); },
    error(requestId, message = '保存超时，本次退出已取消') {
      if (nativePending === requestId) nativePending = null;
      context.failed({payload: {requestId, message}});
    },
    state: () => ({busy: context.busyRef.current, paused: context.collectionPaused.current, request: context.exitPending.current, nativePending}),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('application save-before-exit handlers', () => {
  it('waits for pending credential storage before acknowledging exit', async () => {
    const keyGate = deferred(), h = harness({keyGate});
    h.begin(1); await flush(); h.writes[0].resolve(); await flush();
    expect(h.exits).toEqual([]);expect(h.acks).toEqual([]);
    keyGate.resolve();await flush();expect(h.exits).toEqual([1]);
  });

  it('keeps the application open when the pending key could not be saved', async () => {
    const keyGate = deferred(), h = harness({keyGate});
    h.begin(1); await flush(); h.writes[0].resolve(); await flush();
    keyGate.reject(new Error('密钥尚未保存成功'));await flush();
    expect(h.exits).toEqual([]);expect(h.acks[0].error).toContain('密钥尚未保存成功');
    expect(h.state().busy).toBe(false);
  });
  it('keeps the app open when the knowledge editor refuses to discard an edit or is still saving', async () => {
    const h = harness();
    h.context.knowledgeLeaveGuard.current = () => false;
    h.begin(1); await flush();
    expect(h.writes).toEqual([]);
    expect(h.exits).toEqual([]);
    expect(h.acks).toEqual([{requestId: 1, error: '请先保存知识资料或确认放弃修改，再退出。'}]);
    expect(h.state().busy).toBe(false);
    h.context.knowledgeLeaveGuard.current = () => true;
    h.begin(2); await flush();
    h.writes[0].resolve(); await flush();
    expect(h.exits).toEqual([2]);
  });
  it('renders an explicit exit button wired only to the native save handshake', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined), setError = vi.fn();
    const context = vm.createContext({React, invoke, setError, busy: false});
    const render = () => vm.runInContext(ts.transpileModule(`globalThis.button = (${extracted.get('exit-button').getText(ast)});`, {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React},
    }).outputText, context);
    render();
    expect(renderToStaticMarkup(context.button)).toContain('完全退出');
    expect(context.button.props.title).toContain('保存对局');
    expect(context.button.props.disabled).toBe(false);
    context.button.props.onClick(); await flush();
    expect(invoke).toHaveBeenCalledWith('desktop_request_exit');
    expect(setError).not.toHaveBeenCalled();
    context.busy = true; render();
    expect(context.button.props.disabled).toBe(true);
  });

  it('surfaces an exit request failure instead of silently forcing the process closed', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('save listener not ready')), setError = vi.fn();
    const context = vm.createContext({React, invoke, setError, busy: false});
    vm.runInContext(ts.transpileModule(`globalThis.button = (${extracted.get('exit-button').getText(ast)});`, {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React},
    }).outputText, context);
    context.button.props.onClick(); await flush();
    expect(setError).toHaveBeenCalledWith('Error: save listener not ready');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not let a timed-out save/history refresh clear a newer exit request', async () => {
    const h = harness({archive: true});
    h.begin(1); await flush();
    h.error(1);
    h.begin(2); await flush();
    h.writes[0].resolve(); await flush();
    h.writes[1].resolve(); await flush();
    expect(h.history).toHaveLength(2);
    expect(h.state()).toEqual({busy: true, paused: true, request: 2, nativePending: 2});

    // Original regression: A returns from its actual save() while B's actual
    // save() is still refreshing the archive. A must not acknowledge or unlock.
    h.history[0].resolve(); await flush();
    expect(h.state()).toEqual({busy: true, paused: true, request: 2, nativePending: 2});
    expect(h.acks).toEqual([]);
    expect(h.exits).toEqual([]);
    h.history[1].resolve(); await flush();
    expect(h.exits).toEqual([2]);
    expect(h.acks).toEqual([{requestId: 2, error: null}]);
  });

  it('ignores a late write failure from a timed-out request while a new save runs', async () => {
    const h = harness();
    h.begin(1); await flush(); h.error(1); h.begin(2); await flush();
    h.writes[0].reject(new Error('old write failed')); await flush();
    expect(h.state()).toEqual({busy: true, paused: true, request: 2, nativePending: 2});
    expect(h.errors).not.toContain('退出前保存失败：Error: old write failed');
    expect(h.acks).toEqual([]);
    h.writes[1].resolve(); await flush();
    expect(h.exits).toEqual([2]);
  });

  it('ignores delayed old timeout events and duplicate before-exit events', async () => {
    const h = harness();
    h.begin(1); await flush(); h.error(1); h.begin(2); await flush();
    const errors = h.errors.length;
    h.error(1, 'late old timeout');
    h.context.before({payload: {requestId: 1}});
    h.context.before({payload: {requestId: 2}});
    expect(h.state()).toEqual({busy: true, paused: true, request: 2, nativePending: 2});
    expect(h.errors).toHaveLength(errors);
    h.writes[0].resolve(); await flush(); h.writes[1].resolve(); await flush();
    expect(h.exits).toEqual([2]);
  });

  it.each(['resolve', 'reject'])('isolates a late IPC %s after cancellation and a retry', async result => {
    const h = harness();
    const oldReply = h.holdReply(1);
    h.begin(1); await flush(); h.writes[0].resolve(); await flush();
    expect(h.acks).toEqual([{requestId: 1, error: null}]);
    h.error(1); h.begin(2); await flush();
    oldReply[result](new Error('late old IPC response')); await flush();
    expect(h.state()).toEqual({busy: true, paused: true, request: 2, nativePending: 2});
    expect(h.errors.some(error => error.includes('late old IPC response'))).toBe(false);
    h.writes[1].resolve(); await flush();
    expect(h.exits).toEqual([2]);
  });

  it('does not clear another operation after timeout or a busy exit rejection', async () => {
    const h = harness();
    h.begin(1); await flush(); h.error(1);
    h.context.busyRef.current = true;
    h.context.collectionPaused.current = true;
    h.begin(2); await flush();
    h.writes[0].resolve(); await flush();
    h.error(1); h.error(2);
    expect(h.state()).toEqual({busy: true, paused: true, request: null, nativePending: null});
    expect(h.acks).toHaveLength(1);
    expect(h.acks[0].requestId).toBe(2);
    expect(h.acks[0].error).toContain('分析或数据操作');
    expect(h.exits).toEqual([]);
  });

  it('cancels a failed save without exiting and allows a successful retry', async () => {
    const h = harness();
    h.begin(1); await flush();
    h.writes[0].reject(new Error('disk full')); await flush();
    expect(h.state()).toEqual({busy: false, paused: false, request: null, nativePending: null});
    expect(h.errors).toContain('退出前保存失败：Error: disk full');
    expect(h.exits).toEqual([]);
    h.begin(2); await flush();
    expect(h.exits).toEqual([]);
    h.writes[1].resolve(); await flush();
    expect(h.exits).toEqual([2]);
  });

  it('waits for the real save queue before acknowledging a normal exit', async () => {
    const h = harness();
    h.begin(1); await flush();
    expect(h.state()).toEqual({busy: true, paused: true, request: 1, nativePending: 1});
    expect(h.acks).toEqual([]);
    h.writes[0].resolve(); await flush();
    expect(h.acks).toEqual([{requestId: 1, error: null}]);
    expect(h.exits).toEqual([1]);
  });
});
