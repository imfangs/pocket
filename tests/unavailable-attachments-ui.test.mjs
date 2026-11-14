import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createReadingCache } from '../src/readingCache.ts';
import { displayConversation } from '../src/transcript.ts';
import { unavailableAttachmentText } from '../src/unavailableAttachmentText.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Message } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
after(() => vite.close());
const thread = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const names = [{ name: 'review-notes.docx', kind: 'file' }, { name: '截图 01.png', kind: 'image' }];
const user = { id: 'native-user', role: 'user', text: '审核好了\n\n[2 个附件需在 Mac 中查看]', unavailableAttachments: names, unavailableAttachmentPlaceholder: true };
const render = message => renderToStaticMarkup(createElement(Message, { threadId: thread, message }));

test('native filenames are descriptive cards without links, previews or changes to the query', () => {
  const before = structuredClone(user), html = render(user);
  assert.match(html, /审核好了/); assert.match(html, /review-notes\.docx/); assert.match(html, /截图 01\.png/);
  assert.equal((html.match(/class="attachment-card attachment-unavailable"/g) || []).length, 2);
  assert.doesNotMatch(html, /<img |href=|data-attachment-id=|aria-haspopup="dialog"|\[附件需在/);
  assert.deepEqual(user, before);
});

test('filename markup stays literal and only user attachments receive unavailable cards', () => {
  const html = render({ ...user, unavailableAttachments: [{ name: '<img onerror=alert(1)>.txt', kind: 'file' }] });
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;\.txt/); assert.doesNotMatch(html, /<img |onerror="/);
  assert.doesNotMatch(render({ ...user, role: 'assistant' }), /review-notes|attachment-unavailable/);
  assert.doesNotMatch(render({ ...user, unavailableAttachments: [null, { name: '/private/secret.txt', kind: 'file' }] }), /attachment-unavailable/);
});

test('registered uploads retain their original capability and do not duplicate descriptive cards', () => {
  const html = render({ ...user, attachments: [{ id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', name: 'actual.txt', kind: 'file',
    mime: 'text/plain', size: 5, url: `/api/tasks/${thread}/attachments/bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb` }] });
  assert.match(html, /actual\.txt/); assert.doesNotMatch(html, /review-notes|attachment-unavailable|Mac 中查看/);
});

test('reading metadata survives a disk DTO roundtrip while paths and file capabilities are discarded', async t => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), preferences = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, String(value)), removeItem: key => preferences.delete(key),
  } });
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; });
  const records = new Map();
  const storage = { transcript: async key => records.get(key) ?? null, catalog: async () => null,
    async write(batch) { batch.forEach(record => records.set(record.key, structuredClone(record))); }, close() {} };
  const now = () => 1790000000000;
  const first = createReadingCache({ storage, now }); t.after(() => first.dispose());
  const raw = { ...user, unavailableAttachments: names.map(item => ({ ...item, path: '/private/secret', url: '/api/secret', id: 'private-id' })),
    attachmentPaths: [{ path: '/private/secret' }], images: { secret: '/api/image' } };
  assert.equal(first.rememberTranscript('ged', 'scope', thread, { source: 'rollout', messages: [raw], checkedAt: now() }), true);
  await first.flush(); first.dispose();
  const restored = createReadingCache({ storage, now }); t.after(() => restored.dispose());
  const message = (await restored.loadTranscript('ged', 'scope', thread)).value.messages[0];
  assert.deepEqual(message.unavailableAttachments, names); assert.equal(message.text, user.text); assert.equal(message.id, user.id);
  assert.equal(message.unavailableAttachmentPlaceholder, true);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /\/private\/|\/api\/|private-id|attachmentPaths|"images"/);
  assert.match(render(message), /review-notes\.docx/);
});

test('attachment-only messages and missing live metadata survive display merging and bounds', () => {
  const live = { source: 'desktop', messages: [{ ...user, text: '', unavailableAttachments: undefined }], hasMore: false };
  const saved = { source: 'rollout', messages: [{ ...user, text: '' }], hasMore: false };
  const displayed = displayConversation(live, saved);
  assert.equal(displayed.messages.length, 1); assert.deepEqual(displayed.messages[0].unavailableAttachments, names);
  assert.match(render(displayed.messages[0]), /review-notes\.docx/);
});

test('merging longer recorded text does not borrow a generated-suffix marker from a different native text', () => {
  const placeholder = '[附件需在 Mac 中查看]';
  const live = { source: 'desktop', messages: [{ ...user, text: placeholder, unavailableAttachments: [names[0]] }] };
  const authored = placeholder + '\n\n我写的占位：\n\n' + placeholder;
  const saved = { source: 'rollout', messages: [{ id: user.id, role: 'user', text: authored }] };
  const displayed = displayConversation(live, saved).messages[0];
  assert.equal(displayed.text, authored); assert.equal(displayed.unavailableAttachmentPlaceholder, undefined);
  assert.equal((render(displayed).match(/\[附件需在 Mac 中查看\]/g) || []).length, 2);
});

test('old API generic placeholders remain readable when filename metadata is absent', () => {
  const html = render({ id: 'legacy', role: 'user', text: '审核好了\n\n[附件需在 Mac 中查看]' });
  assert.match(html, /审核好了/); assert.match(html, /附件需在 Mac 中查看/);
});

test('only the generated suffix is hidden; authored placeholders and mismatching counts remain intact', () => {
  const placeholder = '[附件需在 Mac 中查看]', query = '保留我写的：\n\n' + placeholder;
  assert.equal(unavailableAttachmentText(query + '\n\n' + placeholder, 1, true), query);
  assert.equal(unavailableAttachmentText(query, 1, false), query);
  assert.equal(unavailableAttachmentText(query, 2, true), query);
  assert.equal(unavailableAttachmentText(placeholder, 1, true), '');
  const html = render({ ...user, text: query + '\n\n[2 个附件需在 Mac 中查看]', unavailableAttachmentPlaceholder: true });
  assert.match(html, /review-notes\.docx/); assert.match(html, /保留我写的/);
  assert.equal((html.match(/\[附件需在 Mac 中查看\]/g) || []).length, 1);
  assert.doesNotMatch(html, /2 个附件需在/);
  assert.match(render({ ...user, text: placeholder, unavailableAttachments: [names[0]], truncated: true }), /\[附件需在 Mac 中查看\]/);
});

test('nameless native entries keep a generic card alongside known names', () => {
  const html = render({ ...user, unavailableAttachments: [names[0], { name: '', kind: 'file' }] });
  assert.match(html, /review-notes\.docx/); assert.equal((html.match(/attachment-unavailable/g) || []).length, 2);
  assert.match(html, /class="attachment-name">附件<\/span>/);
});
