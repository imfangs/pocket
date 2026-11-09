import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_QUESTION_INPUT_REPORT || '.local/qa/browser-question-input/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});

// Keep the real VisualViewport object/listeners, replacing only its geometry.
// This exercises focus and Pocket's actual viewport/scroll bindings, not an
// iPhone software keyboard or its native automatic scrolling.
const viewport = (page, height, top = 0, emit = true) => page.evaluate(({ height, top, emit }) => {
  Object.defineProperties(window.visualViewport, {
    height: { configurable: true, get: () => height },
    offsetTop: { configurable: true, get: () => top },
  });
  if (emit) window.visualViewport.dispatchEvent(new Event('resize'));
}, { height, top, emit });
const geometry = input => input.evaluate(node => {
  const scroller = node.closest('.request-actions') || node.closest('.conversation-messages');
  const field = node.getBoundingClientRect(), box = scroller.getBoundingClientRect();
  const top = Math.max(box.top + scroller.clientTop, visualViewport.offsetTop);
  const bottom = Math.min(box.top + scroller.clientTop + scroller.clientHeight, visualViewport.offsetTop + visualViewport.height);
  return { top, bottom, fieldTop: field.top, fieldBottom: field.bottom, scrollTop: scroller.scrollTop,
    active: document.activeElement === node, retained: window.questionEditingNode === node,
    value: node.value, selection: [node.selectionStart, node.selectionEnd], pageScroll: window.scrollY };
});
const visible = async input => {
  const shape = await geometry(input);
  assert.ok(shape.fieldTop >= shape.top - 1 && shape.fieldBottom <= shape.bottom + 1, JSON.stringify(shape));
  assert.equal(shape.active, true);
  assert.equal(shape.retained, true);
  assert.equal(shape.pageScroll, 0, 'Only the answer scroll container moves');
  return shape;
};
const anchorAtClosedBottom = input => input.evaluate(node => {
  window.questionEditingNode = node;
  const scroller = node.closest('.request-actions') || node.closest('.conversation-messages');
  scroller.scrollTop += node.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 8;
  node.setSelectionRange(2, 5);
});
const messages = () => [{ id: 'before', role: 'user', text: 'Keep the ordinary draft and reading position.', timestamp: Date.now() - 3000, turnId: 'initial' },
  { id: 'question-source', role: 'assistant', phase: 'final', text: 'Choose one answer.', timestamp: Date.now() - 2000, turnId: 'initial' },
  { id: 'after', role: 'assistant', phase: 'final', text: 'Later progress remains readable.\n\n'.repeat(28), timestamp: Date.now() - 1000, turnId: 'initial' }];

for (const engine of engines) for (const width of [390, 320]) {
  test(`${engine}: ${width}px optional custom answer follows keyboard geometry without following streaming`, { timeout: 30000 }, () => runScenario({
    engine, name: `${width}px optional answer keyboard visibility`, create: () => createHarness(engine, { width }), record: result => results.push(result),
    async run(h) {
      const original = messages();
      const questions = [{ id: 'question', key: 'a'.repeat(64), sourceMessageId: 'question-source', turnId: 'initial',
        title: 'Which approach should we use? ' + 'Extra question context. '.repeat(8), options: ['Use the first approach', 'Use the second approach'] }];
      h.patchHistory(ids.regular, { messages: original, asyncQuestions: questions, turnTiming: { turnId: 'initial', startedAt: Date.now() - 3000 } });
      const page = await h.open(), root = page.locator('.conversation-messages'), composer = page.locator('.conversation-composer textarea');
      await composer.fill('Ordinary draft survives answer editing.');
      await page.locator('.question-custom').click();
      const input = page.locator('.question-card textarea');
      await input.fill('Custom answer survives viewport changes.');
      await anchorAtClosedBottom(input); await page.waitForTimeout(80);
      await visible(input);
      await viewport(page, 420, 70); await page.waitForTimeout(600);
      const opened = await visible(input);
      assert.equal(opened.value, 'Custom answer survives viewport changes.');
      assert.deepEqual(opened.selection, [2, 5]);
      assert.equal(await page.locator('.inspector').getAttribute('data-keyboard-open'), '');
      // A late final metric can arrive without another resize event.
      await viewport(page, 360, 100, false); await page.waitForTimeout(600); await visible(input);
      await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })));
      await viewport(page, 390, 45); await page.waitForTimeout(550); await visible(input);
      await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })));
      await page.waitForTimeout(650);
      await root.evaluate(node => { node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); node.scrollTop = 0; }); await page.waitForTimeout(80);
      const readingTop = await root.evaluate(node => node.scrollTop);
      h.patchHistory(ids.regular, { messages: [...original, { id: 'new-progress', role: 'assistant', phase: 'final', text: 'Fresh progress must not steal answer or reading intent.', turnId: 'initial', timestamp: Date.now() }], asyncQuestions: questions, turnTiming: { turnId: 'initial', startedAt: Date.now() - 3000 } });
      await refresh(page); await page.getByText('Fresh progress must not steal answer or reading intent.', { exact: true }).waitFor();
      await page.waitForTimeout(200);
      assert.ok(Math.abs(await root.evaluate(node => node.scrollTop) - readingTop) <= 1, 'Streaming does not keep revealing a focused answer');
      await page.evaluate(() => visualViewport.dispatchEvent(new Event('scroll'))); await page.waitForTimeout(1100);
      assert.ok(Math.abs(await root.evaluate(node => node.scrollTop) - readingTop) <= 1, 'Keyboard dismissal tail events preserve deliberate reading');
      assert.equal(await input.evaluate(node => node === window.questionEditingNode), true);
      assert.equal(await composer.inputValue(), 'Ordinary draft survives answer editing.');
      await composer.focus(); await viewport(page, 420, 0); await page.waitForTimeout(1100);
      assert.equal(await composer.evaluate(node => document.activeElement === node), true, 'A different editor owns the keyboard');
      assert.equal(await input.inputValue(), 'Custom answer survives viewport changes.');
      assert.equal(h.calls.filter(call => call.method === 'POST' && call.action !== 'sync').length, 0, 'Editing never submits or connects the owner');
    },
  }));

  test(`${engine}: ${width}px blocking answers scroll their own clipped region and preserve the message reader`, { timeout: 30000 }, () => runScenario({
    engine, name: `${width}px blocking answer keyboard visibility`, create: () => createHarness(engine, { width }), record: result => results.push(result),
    async run(h) {
      const request = { key: 'request-question', kind: 'questions', reason: 'Question context. '.repeat(30), cwd: '', choices: [],
        questions: [{ id: 'one', question: 'Write the answer after these options.', options: [{ label: 'Option one' }, { label: 'Option two' }] },
          { id: 'secret', question: 'Secret answer', isSecret: true }] };
      h.patchHistory(ids.regular, { messages: messages(), pendingRequests: [request] });
      const page = await h.open(), reader = page.locator('.conversation-messages'), input = page.locator('.approval-text-answer');
      await reader.evaluate(node => { node.scrollTop = 70; });
      await input.fill('Keep this blocking answer.');
      await anchorAtClosedBottom(input); await page.waitForTimeout(80); await visible(input);
      const readerBefore = await reader.evaluate(node => node.scrollTop);
      await viewport(page, 420, 70); await page.waitForTimeout(600); await visible(input);
      assert.ok(Math.abs(await reader.evaluate(node => node.scrollTop) - readerBefore) <= 1, 'Answer scrolling preserves message reading position');
      const value = 'A growing answer. '.repeat(30);
      await input.fill(value); await page.waitForTimeout(120); await visible(input);
      assert.equal(await input.inputValue(), value);
      const secret = page.locator('.approval-question input[type="password"]');
      await secret.fill('Synthetic secret'); await secret.evaluate(node => { window.questionEditingNode = node; });
      await viewport(page, 360, 100); await page.waitForTimeout(600); await visible(secret);
      await reader.evaluate(node => { node.scrollTop = 0; });
      await page.locator('.conversation-composer textarea').focus();
      const top = await page.locator('.request-actions').evaluate(node => node.scrollTop);
      await viewport(page, 380, 45); await page.waitForTimeout(1100);
      assert.equal(await page.locator('.request-actions').evaluate(node => node.scrollTop), top, 'An inactive answer region does not scroll for another editor');
      assert.equal(await input.inputValue(), value);
      assert.equal(h.calls.filter(call => call.method === 'POST' && call.action !== 'sync').length, 0);
    },
  }));
}
