import test from 'node:test';
import assert from 'node:assert/strict';
import { focusInspectorEntry, inspectorEntryFromClick } from '../src/inspectorFocus.ts';

function fixture() {
  const calls = [];
  let modal = false;
  const back = { focus: options => calls.push({ target: 'back', options }) };
  const panel = { ownerDocument: { querySelector: () => modal }, querySelector: () => back,
    focus: options => calls.push({ target: 'panel', options }) };
  return { panel, calls, modal: value => { modal = value; } };
}

test('pointer and keyboard entry use actual activation instead of animation preferences', () => {
  assert.equal(inspectorEntryFromClick({ detail: 1 }), 'pointer');
  assert.equal(inspectorEntryFromClick({ detail: 2 }), 'pointer');
  assert.equal(inspectorEntryFromClick({ detail: 0 }), 'keyboard');
});
test('pointer entry focuses the reading container without selecting the back button', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'pointer');
  assert.deepEqual(f.calls, [{ target: 'panel', options: { preventScroll: true } }]);
});
test('keyboard entry keeps an actionable focus target', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'keyboard');
  assert.deepEqual(f.calls, [{ target: 'back', options: { preventScroll: true } }]);
});
test('notifications, deep links and unspecified entry focus neutral content', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'programmatic'); focusInspectorEntry(f.panel);
  assert.deepEqual(f.calls.map(call => call.target), ['panel', 'panel']);
});
test('entry focus cannot steal focus from an open modal and can resume after it closes', () => {
  const f = fixture(); f.modal(true); focusInspectorEntry(f.panel, 'pointer');
  assert.deepEqual(f.calls, []);
  f.modal(false); focusInspectorEntry(f.panel, 'pointer'); assert.equal(f.calls[0].target, 'panel');
});
