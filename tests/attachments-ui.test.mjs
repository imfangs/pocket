import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Conversation }, { default: Message }, { default: Submitted }, { default: Outbox }, { default: AttachmentList, AttachmentPicker, DraftAttachmentList }] = await Promise.all([
  vite.ssrLoadModule('/src/Conversation.tsx'), vite.ssrLoadModule('/src/ConversationMessage.tsx'),
  vite.ssrLoadModule('/src/SubmittedQueryCards.tsx'), vite.ssrLoadModule('/src/Outbox.tsx'), vite.ssrLoadModule('/src/AttachmentList.tsx'),
]);
after(() => vite.close());

const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const attachment = (kind = 'image') => ({
  id: kind === 'image' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: kind === 'image' ? '现场图片.heic' : '完整说明与检查清单'.repeat(12) + '.pdf', size: 42, mime: kind === 'image' ? 'image/jpeg' : 'application/pdf',
  kind, sha256: 'a'.repeat(64),
  url: `/api/tasks/${threadId}/attachments/${kind === 'image' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}`,
});
const image = attachment(), file = attachment('file');
const draftAttachment = (status = 'uploaded') => ({ ...image, status, attachment: status === 'uploaded' ? image : undefined });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({
  text: match[2].replace(/<[^>]*>/g, '').trim(), disabled: /\bdisabled(?:=|\s|$)/.test(match[1]),
}));
function composer(items, extra = {}) {
  const history = { source: 'desktop', runtime: 'idle', canSend: true, canQueue: true, messages: [], outbox: [], hint: '', checkedAt: 1 };
  return render(Conversation, { thread: { id: threadId, archived: false, missing: false },
    drafts: new Map([[threadId, { text: '', attachments: items }]]),
    historyCache: new Map([[threadId, { history, scrollTop: 0, nearBottom: true }]]), onConnect: async () => ({}), ...extra });
}
const submission = status => ({ threadId, requestId: 'submitted-one', text: '', attachments: [image, file], status, createdAt: 1 });
const renderSubmitted = status => render(Submitted, { items: [submission(status)], connecting: false, paused: false, disabled: false, check: async () => {}, dismiss() {}, restore: async () => {} });

test('attachment-only composer can submit a stable upload row while removal still blocks ownership transfer', () => {
  assert.equal(buttons(composer([draftAttachment()])).find(button => button.text === '发送').disabled, false);
  for (const status of ['queued', 'uploading', 'unknown', 'failed']) {
    assert.equal(buttons(composer([draftAttachment(), { ...draftAttachment(status), id: file.id }])).find(button => button.text === '发送').disabled, false, status);
  }
  for (const extra of [{ status: 'removing' }, { status: 'unknown', deletePending: true }, { status: 'uploaded', deletePending: true }]) {
    const status = JSON.stringify(extra);
    assert.equal(buttons(composer([draftAttachment(), { ...draftAttachment(), ...extra, id: file.id }])).find(button => button.text === '发送').disabled, true, status);
  }
  assert.equal(buttons(composer([])).find(button => button.text === '发送').disabled, true);
  assert.equal(buttons(composer([draftAttachment()], { thread: { id: threadId, archived: true, missing: false } })).find(button => button.text === '发送').disabled, true);
});

test('native picker supports multiple arbitrary files without a camera or MIME restriction', () => {
  const html = render(AttachmentPicker, { disabled: false, onFiles() {} });
  assert.match(html, /aria-label="添加附件"/);
  const input = html.match(/<input\b[^>]*>/)[0];
  assert.match(input, /type="file"/); assert.match(input, /multiple=""/);
  assert.match(input, /data-attachment-input=""/); assert.match(input, /aria-label="选择附件"/);
  assert.doesNotMatch(input, /\b(?:accept|capture|disabled)=/);
});

test('unknown uploads expose read-only verification and removal without an upload retry', () => {
  const html = render(DraftAttachmentList, { threadId, items: [draftAttachment('unknown')], controller: {}, disabled: false });
  assert.match(html, /data-upload-status="unknown"/); assert.match(html, /结果待核对/);
  assert.match(html, /aria-label="核对附件 现场图片.heic"/); assert.match(html, /aria-label="移除附件 现场图片.heic"/);
  assert.doesNotMatch(html, /重试上传/);
  const failed = render(DraftAttachmentList, { threadId, items: [draftAttachment('failed')], controller: {}, disabled: false });
  assert.match(failed, /aria-label="重试上传 现场图片.heic"/);
});

test('offline removal is available only for a local attachment in an editable composer', () => {
  const removal = (status, extra = {}, localRemovalAllowed = true) => {
    const html = render(DraftAttachmentList, { threadId, items: [{ ...draftAttachment(status), ...extra }], controller: {}, disabled: true, localRemovalAllowed });
    return html.match(/<button[^>]*aria-label="移除附件 [^"]+"[^>]*>/)?.[0];
  };
  for (const status of ['queued', 'failed']) assert.doesNotMatch(removal(status), /disabled/);
  for (const status of ['uploaded', 'uploading', 'unknown', 'removing']) assert.match(removal(status), /disabled/);
  for (const extra of [{ attachment: image }, { checking: true }, { deletePending: true }]) assert.match(removal('failed', extra), /disabled/);
  assert.match(removal('failed', {}, false), /disabled/, 'sending or management restrictions cannot be bypassed');
});

test('attachment-only native messages show a thumbnail and a downloadable file without an empty copy action', () => {
  const html = render(Message, { message: { id: 'native', role: 'user', text: '', attachments: [image, file], timestamp: 1 } });
  assert.match(html, /aria-label="消息附件"/); assert.match(html, /attachment-placeholder/);
  assert.match(html, /aria-label="查看大图：现场图片.heic"/); assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /download="完整说明与检查清单/); assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /复制这条消息/);
  assert.ok(html.includes(`aria-label="查看附件 ${file.name}"`));
  assert.ok(html.includes(`title="${file.name}"`));
  assert.ok(html.indexOf('<footer class="message-footer">') > html.indexOf(`data-attachment-id="${file.id}"`));
  assert.match(html, /<footer[^>]*>[\s\S]*dateTime="[^"]+"[\s\S]*<\/footer><\/article>$/);
});

test('small image previews use a same-page image viewer trigger rather than a thumbnail link', () => {
  const previewUrl = `${image.url}?preview=1`;
  const html = render(AttachmentList, { attachments: [{ ...image, previewUrl }] });
  assert.match(html, /attachment-placeholder/); assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /<button[^>]+aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<a\b|target="_blank"/);
  assert.ok(!html.includes(`href="${previewUrl}"`));
});

test('attachment recovery errors retain an explicit retry entry even when the draft is empty', () => {
  const html = render(DraftAttachmentList, { threadId, items: [], controller: {}, disabled: false, error: '暂时无法载入已上传附件，请重试。', onRecover() {} });
  assert.match(html, /role="alert"/); assert.match(html, /暂时无法载入已上传附件/);
  assert.equal(buttons(html).find(button => button.text === '载入已上传附件').disabled, false);
});

test('attachment read failures are readable rather than raw browser network errors', () => {
  const html = render(DraftAttachmentList, { threadId, items: [{ ...draftAttachment('unknown'), error: 'Fetch is aborted' }],
    controller: {}, disabled: false, error: 'Load failed', onRecover() {} });
  assert.doesNotMatch(html, /Fetch is aborted|Load failed/);
  assert.match(html, /连接暂时中断/);
  assert.match(html, /data-upload-status="unknown"/);
});

test('submitted and queued attachment-only messages retain both attachments independently of the composer', () => {
  const queued = { id: 'queue-one', revision: 0, text: '', status: 'queued', attachments: [image, file], createdAt: 1 };
  for (const html of [renderSubmitted('unknown'), render(Outbox, { threadId, items: [queued], disabled: false, allowSend: true, refresh: async () => {}, drafts: new Map() })]) {
    assert.ok(html.includes(`data-attachment-id="${image.id}"`)); assert.ok(html.includes(`data-attachment-id="${file.id}"`));
    assert.match(html, /aria-label="消息附件"/);
  }
  assert.doesNotMatch(renderSubmitted('unknown'), /复制已提交消息/);
});

test('only definitely rejected or missing submissions expose re-edit while unknown outcomes retain verification', () => {
  for (const status of ['rejected', 'not_found']) assert.match(renderSubmitted(status), />重新编辑<\/button>/);
  for (const status of ['unknown', 'pending', 'accepted', 'queued', 'cancelled']) assert.doesNotMatch(renderSubmitted(status), />重新编辑<\/button>/);
  assert.match(renderSubmitted('unknown'), />核对状态<\/button>/);
  assert.match(renderSubmitted('unknown'), /核对不会重复发送/);
});

test('attachment display refuses external and script URLs while retaining the filename', () => {
  for (const url of ['https://external.example/private', 'javascript:alert(1)', 'blob:private']) {
    const html = render(AttachmentList, { attachments: [{ ...image, url }] });
    assert.match(html, /现场图片.heic/); assert.doesNotMatch(html, /<a\b|<img\b|href=|src=/);
  }
});
