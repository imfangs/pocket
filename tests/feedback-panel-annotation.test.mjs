import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createUndoStack, Origin } from '@annotorious/core';
import { initialAnnotationHistory } from '../packages/feedback-kit/react/annotationHistory.ts';

test('the first annotation remains safe even during the library merge window immediately after page startup', () => {
  const original = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { value: () => 10, configurable: true });
  const store = createStore(), history = createUndoStack(store, initialAnnotationHistory());
  try {
    assert.doesNotThrow(() => store.addAnnotation({ id: 'first', bodies: [], target: { annotation: 'first',
      selector: { type: 'RECTANGLE', geometry: { x: 1, y: 2, w: 3, h: 4, bounds: { minX: 1, minY: 2, maxX: 4, maxY: 6 } } } } }, Origin.LOCAL));
    assert.equal(store.all().length, 1);
    assert.equal(history.getHistory().changes.length, 1);
  } finally {
    history.destroy();
    if (original) Object.defineProperty(performance, 'now', original); else delete performance.now;
  }
});

test('each image receives its own undo baseline', () => {
  const first = initialAnnotationHistory(), second = initialAnnotationHistory();
  first.changes.push({ created: [{ id: 'a' }] });
  assert.equal(second.changes.length, 1);
});
