import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/AutoTextarea.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Run the real layout effect against a flex layout with WebKit's observed
// behavior: a forced layout after reducing the textarea clamps its sibling to
// the temporarily shorter scroll range, even if the final height is unchanged.
function measure({ top, initialHeight = 140, naturalHeight = 140, inConversation = true }) {
  const controls = 100, conversationHeight = 440, contentHeight = 3000;
  let messageTop = top, clampedDuringMeasure = false, cleanup;
  const height = () => Math.max(48, parseFloat(input.style.height));
  const maxScroll = () => contentHeight - (conversationHeight - controls - height());
  const layout = () => {
    if (messageTop > maxScroll()) { messageTop = maxScroll(); clampedDuringMeasure = true; }
  };
  const messages = {
    get scrollTop() { layout(); return messageTop; },
    set scrollTop(value) { messageTop = Math.max(0, Math.min(value, maxScroll())); },
  };
  const group = { get scrollHeight() { layout(); return height() + controls; } };
  const conversation = { clientHeight: conversationHeight,
    children: [group, { classList: { contains: name => name === 'conversation-feed' } }],
    querySelector: selector => selector === '.conversation-messages' ? messages : null,
  };
  const input = { style: { height: `${initialHeight}px` }, scrollTop: 23,
    get scrollHeight() { layout(); return naturalHeight; },
    getBoundingClientRect() { layout(); return { width: 300, height: height() }; },
    closest(selector) {
      if (!inConversation) return null;
      if (selector === '.conversation') return conversation;
      return selector.includes('.conversation-composer') ? group : null;
    },
  };
  const Observer = class { observe() {} disconnect() {} };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports,
    getComputedStyle: () => ({ minHeight: '48px', maxHeight: '240px', borderTopWidth: '0px', borderBottomWidth: '0px' }),
    window: { innerHeight: 440, addEventListener() {}, removeEventListener() {} },
    ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    require(name) {
      if (name === 'react') return { useRef: () => ({ current: input }), useLayoutEffect: callback => { cleanup = callback(); } };
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
      throw Error(`Unexpected import: ${name}`);
    },
  });
  const rendered = module.exports.default({ value: 'draft', onCompositionStart() {} });
  cleanup();
  return { top: messages.scrollTop, max: maxScroll(), height: height(), clampedDuringMeasure, input, rendered };
}

test('typing at the latest message restores scroll clamped by temporary textarea measurement', () => {
  const result = measure({ top: 2800 });
  assert.equal(result.clampedDuringMeasure, true, 'fixture reproduces the native intermediate clamp');
  assert.equal(result.height, 140);
  assert.equal(result.top, 2800, 'same final layout keeps the latest message in place');
  assert.equal(result.input.scrollTop, 23, 'textarea scroll is retained');
});

test('an existing reading position is retained without turning measurement into bottom-following', () => {
  assert.equal(measure({ top: 2760 }).top, 2760, 'near-bottom manual reading also survives the intermediate clamp');
  assert.equal(measure({ top: 1000 }).top, 1000, 'reading earlier text is not moved to latest');
  const grown = measure({ top: 1000, initialHeight: 60 });
  assert.equal(grown.top, 1000, 'real textarea growth preserves earlier reading');
});

test('genuine textarea shrink is limited to the settled scroll range and standalone inputs still size', () => {
  const shrunk = measure({ top: 2800, naturalHeight: 60 });
  assert.equal(shrunk.height, 60);
  assert.equal(shrunk.top, shrunk.max, 'restoration never scrolls past the actual new bottom');
  const standalone = measure({ top: 1000, inConversation: false });
  assert.equal(standalone.height, 140);
  assert.equal(standalone.rendered.type, 'textarea');
  assert.equal(standalone.rendered.props.value, 'draft');
  assert.equal(typeof standalone.rendered.props.onCompositionStart, 'function');
});
