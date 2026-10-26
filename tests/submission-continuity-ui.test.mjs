import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createSubmittedQueryStore, seedSubmittedQuery } from '../src/submittedQueries.ts';
import { queueHeadState } from '../src/submissionFeedback.ts';

// Portal targets are DOM refs, so SSR cannot render their action subtree. Capture
// the real Conversation boundary props; controller actions have their own tests.
const probeKey = Symbol.for('pocket.ssr.submission-continuity-ui.test.mjs');
globalThis[probeKey] = {};
const controllerBoundary = {
  name: 'capture-conversation-controller-props', enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.endsWith('/src/Conversation.tsx') && ['./Outbox', './SubmittedQueryCards'].includes(source))
      return '\0' + 'pocket.ssr.submission-continuity-ui.test.mjs' + source;
  },
  load(id) {
    if (!id.startsWith('\0' + 'pocket.ssr.submission-continuity-ui.test.mjs')) return;
    const name = id.endsWith('/Outbox') ? 'outbox' : 'submitted';
    return `export default function ControllerBoundary(props) { globalThis[Symbol.for(${JSON.stringify('pocket.ssr.submission-continuity-ui.test.mjs')})][${JSON.stringify(name)}] = props; return null; }`;
  },
};

const vite = await createServer({ plugins: [controllerBoundary], configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(async () => { delete globalThis[probeKey]; await vite.close(); });

function render(submissions, history, drafts = new Map()) {
  globalThis[probeKey] = {};
  return renderToStaticMarkup(createElement(Conversation, {
    thread: { id: 'thread', archived: false, missing: false }, drafts, submissions,
    historyCache: history ? new Map([['thread', { history, scrollTop: 0, nearBottom: true }]]) : new Map(),
    onConnect: async () => ({}),
  }));
}
const history = overrides => ({ source: 'desktop', runtime: 'idle', canSend: true, checkedAt: 1, messages: [], outbox: [], hint: '', ...overrides });
const entry = { threadId: 'thread', requestId: 'submitted-one', text: 'The submitted first query', status: 'accepted', createdAt: 1 };
const outbox = { id: entry.requestId, text: entry.text, status: 'queued', revision: 0, createdAt: 1 };
function assertSingleQuery(html) {
  assert.equal(html.split(entry.text).length - 1, 1, 'one complete submitted body');
  assert.equal((html.match(/data-query-id="submitted-one"/g) || []).length, 1, 'one stable query row');
  assert.equal((html.match(/aria-label="复制这条消息"/g) || []).length, 1, 'one message copy action');
  assert.doesNotMatch(html, /data-submission-id=|data-outbox-id=|复制已提交消息|class="submitted-queries"|class="outbox"/);
}

test('accepted first query remains visible while native history has not echoed it and a new draft is being written', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const drafts = new Map([['thread', { text: 'An independent next query' }]]);
  const html = render(submissions, undefined, drafts);
  assertSingleQuery(html);
  assert.match(html, /data-query-state="accepted"/);
  assert.equal(globalThis[probeKey].submitted.items[0].status, 'accepted', 'inline controls own the success state');
  assert.equal(globalThis[probeKey].outbox.items.length, 0);
  assert.doesNotMatch(html, /conversation-feedback|send-feedback/);
  assert.doesNotMatch(html, /<strong>你<\/strong>|原文已保留|消息出现前会保留/);
  assert.match(html, /<textarea[^>]*>An independent next query<\/textarea>/);
  assert.equal(drafts.get('thread').text, 'An independent next query');
});

test('quick creation shows a queued first query before the first history response', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'queued' });
  const html = render(submissions);
  assertSingleQuery(html);
  assert.match(html, /data-query-state="queued"/);
  assert.equal(globalThis[probeKey].submitted.items[0].status, 'queued');
  assert.equal(globalThis[probeKey].submitted.connecting, true);
  assert.ok(globalThis[probeKey].submitted.inlineTargets instanceof Map);
  assert.doesNotMatch(html, /已发送|原文已保留/);
});

test('real outbox renders exactly one copy and accepted receipt overrides a stale queued row', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const html = render(submissions, history({ outbox: [outbox] }));
  assertSingleQuery(html);
  assert.match(html, /data-query-state="accepted"/);
  assert.equal(globalThis[probeKey].submitted.items.length, 0);
  assert.equal(globalThis[probeKey].outbox.items[0].status, 'accepted', 'stale queued status cannot restore mutable controls');
  assert.doesNotMatch(html, /data-query-breathing="true"/);
});

test('rendered exact user echo replaces both temporary card and stale outbox in one frame', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const messages = [{ id: 'native-message', role: 'user', clientMessageId: entry.requestId, text: entry.text }];
  const html = render(submissions, history({ messages, outbox: [outbox] }));
  assertSingleQuery(html);
  assert.match(html, /data-message-id="native-message"/);
  assert.equal(globalThis[probeKey].submitted.items.length, 0);
  assert.equal(globalThis[probeKey].outbox.items.length, 0);
});

test('unknown submission retains its original text while the independent draft stays editable', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'unknown' });
  const html = render(submissions, history(), new Map([['thread', { text: 'A new draft' }]]));
  assertSingleQuery(html);
  assert.match(html, /data-query-state="unknown"/);
  assert.equal(globalThis[probeKey].submitted.items[0].status, 'unknown', 'only verification actions are exposed for an unknown receipt');
  assert.equal(typeof globalThis[probeKey].submitted.check, 'function');
  assert.equal(globalThis[probeKey].outbox.items.length, 0);
  assert.doesNotMatch(html, /data-query-state="accepted"/);
  assert.match(html, /<textarea[^>]*>A new draft<\/textarea>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.ok(submissions.reloadBlocker());
});

test('a same-id truncated history echo uses one complete query body without retiring its receipt', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const messages = [{ id: 'truncated-native', role: 'user', clientMessageId: entry.requestId, text: 'The submitted', truncated: true }];
  const html = render(submissions, history({ messages }));
  assertSingleQuery(html);
  assert.match(html, /data-message-id="truncated-native"/);
  assert.doesNotMatch(html, /<p>The submitted<\/p>|内容较长，此处已截取/);
  assert.equal(globalThis[probeKey].submitted.items[0].status, 'accepted');
  assert.equal(globalThis[probeKey].submitted.items[0].text, entry.text);
  assert.equal(typeof globalThis[probeKey].submitted.check, 'function');
  assert.ok(submissions.reloadBlocker());
});

test('complete rollout text leaves unknown outbox status and verification controls visible', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'unknown' });
  const messages = [{ id: 'saved-message', role: 'user', clientMessageId: entry.requestId, text: entry.text }];
  const html = render(submissions, history({ source: 'rollout', messages, outbox: [{ ...outbox, status: 'unknown' }] }));
  assertSingleQuery(html);
  assert.match(html, /data-query-state="unknown"/);
  const queue = globalThis[probeKey].outbox;
  assert.equal(queue.items[0].status, 'unknown');
  assert.equal(queueHeadState(queue.items[0]).blocked, true);
  assert.equal(typeof queue.refresh, 'function');
  assert.equal(globalThis[probeKey].submitted.items.length, 0);
  assert.ok(submissions.reloadBlocker());
});
