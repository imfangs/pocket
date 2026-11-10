import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createEarlierHistoryReader } from '../src/earlierHistory.ts';
import { captureEarlierHistoryAnchor, restoreEarlierHistoryAnchor } from '../src/earlierHistoryAnchor.ts';

const source = ts.transpileModule(readFileSync(new URL('../src/useEarlierConversation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Run the production hook and reader with a controlled render/commit boundary.
// A scroll between the store notification and commit is a newer reading intent;
// a native scroll adjustment during the DOM commit is part of the prepend.
function fixture() {
  const request = deferred(), refs = [], dependencies = [], cleanups = [];
  let cursor = 0, effects = [], subscribed = false;
  const doc = { activeElement: null, querySelector: () => null };
  const root = { ownerDocument: doc, scrollTop: 140, querySelector: () => null,
    getBoundingClientRect: () => ({ top: 50, bottom: 550 }), querySelectorAll: () => nodes };
  const row = (id, y) => ({ dataset: { messageId: id }, y,
    getBoundingClientRect() { return { top: 50 + this.y - root.scrollTop, bottom: 150 + this.y - root.scrollTop, width: 300, height: 100 }; } });
  const nodes = [row('message-0', 100), row('message-1', 220), row('message-2', 700), row('message-3', 900)];
  const react = {
    useRef(value) { return refs[cursor++] ??= { current: value }; },
    useMemo(callback) { return refs[cursor++] ??= callback(); },
    useCallback(callback) { cursor++; return callback; },
    useEffect(callback) { const index = cursor++; if (!refs[index]) { refs[index] = true; cleanups.push(callback()); } },
    useLayoutEffect(callback, deps) {
      const index = cursor++, previous = dependencies[index];
      if (!previous || deps.some((dep, i) => dep !== previous[i])) effects.push(() => { dependencies[index] = deps; callback(); });
    },
    useSyncExternalStore(subscribe, snapshot) {
      cursor++;
      if (!subscribed) { subscribed = true; cleanups.push(subscribe(() => {})); }
      return snapshot();
    },
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === 'react') return react;
    if (name === './api') return { api: () => request.promise };
    if (name === './earlierHistory') return { createEarlierHistoryReader };
    if (name === './earlierHistoryAnchor') return { captureEarlierHistoryAnchor, restoreEarlierHistoryAnchor };
    if (name === './earlierHistoryScroll') return { bindEarlierHistoryScroll: () => {} };
    if (name === './useProgressMessages') return { hasMessageSelection: () => false };
    throw Error(`Unexpected hook dependency: ${name}`);
  } });
  const options = { threadId: 'synthetic', root: { current: root }, conversationRoot: { current: {} }, online: true,
    hasEarlierMessages: true, isComposing: () => false, onAutomaticStart() {} };
  const render = (commit = () => {}) => {
    cursor = 0; effects = [];
    const hook = module.exports.useEarlierConversation(options);
    commit(hook.state);
    for (const effect of effects) effect();
    return hook;
  };
  const hook = render();
  return { root, nodes, request, hook, render, close() { for (const cleanup of cleanups.reverse()) cleanup?.(); } };
}

const recent = { source: 'rollout', messages: [
  { id: 'older', role: 'assistant', text: 'Earlier synthetic message.' },
  ...Array.from({ length: 4 }, (_, index) => ({ id: `message-${index}`, role: 'assistant', text: `Synthetic message ${index}.` })),
], hasMore: false, nextCursor: null, page: { kind: 'recent' } };

test('a scroll after the loading notification supersedes its saved reading anchor', async () => {
  const f = fixture();
  try {
    void f.hook.older();
    f.root.scrollTop = 440;
    f.render();
    assert.equal(f.root.scrollTop, 440, 'loading alone must not undo newer reading');
  } finally { f.close(); }
});

test('a scroll after an error notification also keeps the newer reading position', async () => {
  const f = fixture();
  try {
    const loading = f.hook.older(); f.render();
    f.request.reject(new Error('synthetic network failure')); await loading;
    f.root.scrollTop = 440;
    const hook = f.render();
    assert.ok(hook.state.error);
    assert.equal(f.root.scrollTop, 440, 'error UI cannot return to the pre-notification position');
  } finally { f.close(); }
});

test('status layout still restores the visible anchor when no newer scroll took over', () => {
  const f = fixture();
  try {
    void f.hook.older();
    const before = captureEarlierHistoryAnchor(f.root);
    f.render(() => { for (const node of f.nodes) node.y += 20; });
    assert.equal(f.root.scrollTop, 160);
    assert.deepEqual(captureEarlierHistoryAnchor(f.root), before, 'top status height does not displace the reader');
  } finally { f.close(); }
});

test('a genuine historical prepend retains its anchor through native scroll adjustment during commit', async () => {
  const f = fixture();
  try {
    const loading = f.hook.older(); f.render();
    const before = captureEarlierHistoryAnchor(f.root);
    f.request.resolve(recent); await loading;
    const hook = f.render(() => {
      for (const node of f.nodes) node.y += 500;
      f.root.scrollTop += 500; // Native scroll anchoring happens after render.
    });
    assert.equal(hook.state.active, true);
    assert.equal(f.root.scrollTop, 640);
    assert.deepEqual(captureEarlierHistoryAnchor(f.root), before);
  } finally { f.close(); }
});

test('a newer scroll after a prepared page notification is not restored to the old shared message', async () => {
  const f = fixture();
  try {
    const loading = f.hook.older(); f.render();
    f.request.resolve(recent); await loading;
    f.root.scrollTop = 440;
    f.render();
    assert.equal(f.root.scrollTop, 440);
  } finally { f.close(); }
});
