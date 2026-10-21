import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { compactComposer } = await vite.ssrLoadModule('/src/useReadingComposer.ts');
after(() => vite.close());
const reading = { mobile: true, hasContent: true, hasDraft: false, hasAttachments: false, focused: false, composing: false, picking: false, keyboardOpen: false, pending: false, feedback: false };
test('mobile reading can use a compact composer, but a new empty conversation and desktop keep the full entry', () => {
  assert.equal(compactComposer(reading), true);
  assert.equal(compactComposer({ ...reading, mobile: false }), false);
  assert.equal(compactComposer({ ...reading, hasContent: false }), false);
});
test('a retained text draft can be previewed while attachments and unfinished controls stay expanded', () => {
  assert.equal(compactComposer({ ...reading, hasDraft: true }), true);
  for (const field of ['hasAttachments', 'pending', 'feedback']) assert.equal(compactComposer({ ...reading, [field]: true }), false, field);
});
test('focus, composition, a native picker or a closing keyboard prevents a collapse', () => {
  for (const field of ['focused', 'composing', 'picking', 'keyboardOpen']) assert.equal(compactComposer({ ...reading, [field]: true }), false, field);
  // Ending IME composition cannot collapse while focus or the keyboard remains.
  assert.equal(compactComposer({ ...reading, focused: true, composing: false }), false);
  assert.equal(compactComposer({ ...reading, keyboardOpen: true, focused: false }), false);
});
