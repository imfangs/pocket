import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/useProgressMessages.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Chromium can run a microtask checkpoint between focusout and focusin. Exercise
// the real hook effect with that ordering: a temporary activeElement=body must
// not publish an unprotected reading state and trigger the parent's bottom follow.
function fixture() {
  const document = new EventTarget(), browser = new EventTarget(), root = new EventTarget();
  const first = {}, second = {}, outside = {}, inside = new Set([first, second]);
  const frames = new Map(), microtasks = [], cleanups = [], revisions = [];
  let nextFrame = 0, selected = false, overlay = false;
  Object.assign(document, { activeElement: first, defaultView: browser,
    querySelector: () => overlay ? {} : null,
    getSelection: () => ({ isCollapsed: !selected, rangeCount: selected ? 1 : 0,
      getRangeAt: () => ({ intersectsNode: node => node === root }) }),
  });
  Object.assign(root, { ownerDocument: document, contains: node => inside.has(node), querySelectorAll: () => [] });
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports, window: browser,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id), queueMicrotask: callback => microtasks.push(callback),
    require(name) {
      if (name === 'react') return {
        useRef: value => ({ current: value }), useCallback: callback => callback, useMemo: callback => callback(),
        useState: value => [typeof value === 'function' ? value() : value, update => revisions.push(update)],
        useEffect: callback => cleanups.push(callback()), useLayoutEffect() {},
      };
      if (name === './progressGroups') return { groupProgressMessages: () => [] };
      throw Error(`Unexpected import: ${name}`);
    },
  });
  module.exports.useProgressMessages({ messages: [], protectedIds: new Set(), root: { current: root },
    nearBottom: { current: true }, away: false, cache: new Map(), threadId: 'synthetic', onPosition() {} });
  return { document, browser, root, first, second, outside, revisions, frames,
    emit: type => root.dispatchEvent(new Event(type)),
    microtasks() { while (microtasks.length) microtasks.shift()(); },
    paint() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    cleanup() { cleanups.forEach(callback => callback?.()); },
    select(value) { selected = value; document.dispatchEvent(new Event('selectionchange')); },
    overlay(value) { overlay = value; browser.dispatchEvent(new Event('pocket-reading-visibility-change')); },
  };
}

test('reader controls retain protection across the focusout/focusin microtask gap', () => {
  const f = fixture();
  f.document.activeElement = f.outside; f.emit('focusout'); f.microtasks();
  assert.equal(f.revisions.length, 0, 'the transient body focus cannot request a following layout');
  f.document.activeElement = f.second; f.emit('focusin'); f.microtasks(); f.paint();
  assert.equal(f.revisions.length, 0, 'focus still belongs to the reading region');
  f.cleanup();
});

test('a completed move out of the reader releases protection at the next frame', () => {
  const f = fixture();
  f.document.activeElement = f.outside; f.emit('focusout'); f.microtasks();
  assert.equal(f.revisions.length, 0, 'no release during the native focus event sequence');
  f.paint(); assert.equal(f.revisions.length, 1, 'normal following resumes once focus really left');
  f.cleanup();
});

test('rapid focus events coalesce and cleanup cancels pending observation', () => {
  const f = fixture();
  f.emit('focusout'); f.emit('focusin'); f.emit('focusout');
  assert.equal(f.frames.size, 1);
  f.cleanup(); f.document.activeElement = f.outside; f.microtasks(); f.paint();
  assert.equal(f.frames.size, 0); assert.equal(f.revisions.length, 0);
});

test('selection and open viewers continue to protect reading after focus leaves', () => {
  const f = fixture();
  f.select(true); const selectedRevisions = f.revisions.length;
  f.document.activeElement = f.outside; f.emit('focusout'); f.microtasks(); f.paint();
  assert.equal(f.revisions.length, selectedRevisions);
  f.overlay(true); f.select(false); const overlayRevisions = f.revisions.length;
  f.emit('focusout'); f.microtasks(); f.paint(); assert.equal(f.revisions.length, overlayRevisions);
  f.overlay(false); assert.equal(f.revisions.length, overlayRevisions + 1);
  f.cleanup();
});
