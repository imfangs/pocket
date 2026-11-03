import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as queries from '../src/submittedQueries.ts';
import * as feedback from '../src/submissionFeedback.ts';
import * as requestErrors from '../src/requestError.ts';
import { captureDraft } from '../src/draftTransaction.ts';
import { sourceTranslation } from '../src/displayTranslation.ts';

// Exercise the component's real handlers and state transitions without a DOM or
// native API. Layout/selection/44px hit targets are verified in the browser QA.
function mount(file, initial, request = async () => {}, clipboard = async () => {}) {
  let cursor = 0, dirty = false, props = initial, output;
  const slots = [], pending = [];
  const useState = initialValue => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initialValue === 'function' ? initialValue() : initialValue;
    return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }];
  };
  const useRef = value => useState(() => ({ current: value }))[0];
  const effect = (callback, dependencies) => {
    const i = cursor++, previous = slots[i];
    if (!previous || !dependencies || dependencies.some((value, index) => !Object.is(value, previous.dependencies?.[index]))) {
      slots[i] = { dependencies, cleanup: previous?.cleanup };
      pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = callback(); });
    }
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const imports = {
    react: { useState, useRef, useEffect: effect, useLayoutEffect: effect, useId: () => useState('test-text')[0] },
    'react-dom': { createPortal: (children, container, key) => ({ type: 'portal', props: { children, container }, key }) },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': { Check: 'check-icon', CheckCircle2: 'check-circle', Copy: 'copy-icon' },
    './submittedQueries': queries, './submissionFeedback': feedback, './requestError': requestErrors,
    './i18n': { t: sourceTranslation, useLocale: () => 'zh-CN' },
    './AutoTextarea': { default: 'textarea' }, './AttachmentList': { default: 'attachments' },
    './api': { api: request }, './submissionReceipt': { waitForSubmission: async receipt => receipt },
    './updateSafety': { holdReload: () => () => {}, useReloadGuard() {} },
    './draftTransaction': { captureDraft }, './attachments': { attachmentDraftController: () => ({}) },
    './useReceiptHandoff': { NO_HANDOFF_IDS: new Set(), useHandoffRows: items => ({ rows: items.map(item => ({ item, leaving: false })), bind() {} }) },
  };
  const source = ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name.endsWith('.css')) return {};
    assert.ok(name in imports, `unexpected import: ${name}`); return imports[name];
  }, AbortController, setTimeout, clearTimeout, window: new EventTarget(), document: new EventTarget(), navigator: { clipboard: { writeText: clipboard } } }, { filename: file });
  const render = next => {
    if (next) props = next;
    for (let n = 0; n < 20; n++) {
      dirty = false; cursor = 0; output = module.exports.default(props);
      while (pending.length) pending.shift()();
      if (!dirty) return output;
    }
    throw Error('component did not settle');
  };
  render();
  return { render, get output() { return output; }, async flush() { await setImmediate(); return render(); },
    close() { for (const slot of slots) slot?.cleanup?.(); } };
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : text(tree.props?.children);
const row = (tree, id) => nodes(tree).find(node => node.props?.['data-submission-id'] === id || node.props?.['data-outbox-id'] === id);
const button = (tree, name) => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name));
const alerts = tree => nodes(tree).filter(node => node.props?.role === 'alert').map(text);
const item = (id, status = 'unknown') => ({ threadId: 'thread', requestId: id, text: 'Full original query\nSecond line\nThird line', status, createdAt: 1 });
const queueItem = (id, status = 'unknown', revision = 0) => ({ id, text: 'Queued original', status, revision, createdAt: 1 });
const cardProps = items => ({ items, connecting: false, paused: false, disabled: false, dismiss() {}, check: async value => { throw Error(`核对 ${value.requestId} 失败`); } });
const queueProps = items => ({ threadId: 'thread', items, disabled: false, allowSend: true, refresh: async () => {}, drafts: new Map() });

test('card errors follow their own receipt version and never clear another message', async () => {
  const a = item('a'), b = item('b'), props = cardProps([a, b]), ui = mount('SubmittedQueryCards.tsx', props);
  try {
    button(row(ui.output, 'a'), '核对状态').props.onClick(); await ui.flush();
    button(row(ui.output, 'b'), '核对状态').props.onClick(); await ui.flush();
    assert.deepEqual(alerts(ui.output), ['核对 a 失败', '核对 b 失败']);
    ui.render({ ...props, items: [{ ...a, status: 'accepted' }, b] });
    assert.deepEqual(alerts(ui.output), ['核对 b 失败']);
    ui.render({ ...props, items: [b] });
    ui.render(props);
    assert.deepEqual(alerts(ui.output), ['核对 b 失败'], 'a removed receipt cannot resurrect its earlier error');
  } finally { ui.close(); }
});

test('shared connection feedback suppresses only network card errors and unknown stays actionable', async () => {
  const a = item('a'), b = item('b');
  let copied;
  const props = { ...cardProps([a, b]), check: async value => { throw Error(value.requestId === 'a' ? 'Load failed' : '消息内容已变化，请重新核对。'); } };
  const ui = mount('SubmittedQueryCards.tsx', props, undefined, async value => { copied = value; });
  try {
    for (const id of ['a', 'b']) { button(row(ui.output, id), '核对状态').props.onClick(); await ui.flush(); }
    assert.deepEqual(alerts(ui.output), ['连接暂时中断，请重试。', '消息内容已变化，请重新核对。']);
    ui.render({ ...props, suppressNetworkErrors: true });
    assert.deepEqual(alerts(ui.output), ['消息内容已变化，请重新核对。']);
    assert.equal(button(row(ui.output, 'a'), '核对状态').props.disabled, false);
    assert.equal(button(row(ui.output, 'a'), '收起'), undefined);
    assert.equal(button(row(ui.output, 'a'), '重新编辑'), undefined);
    button(row(ui.output, 'a'), '复制已提交消息').props.onClick(); await ui.flush();
    assert.equal(copied, a.text);
    assert.deepEqual(alerts(ui.output), ['消息内容已变化，请重新核对。']);
    assert.ok(nodes(row(ui.output, 'a')).some(node => typeof node.type === 'function' && node.props.text === a.text), 'disclosure receives the complete original text');
  } finally { ui.close(); }
});

test('late card failures cannot attach to a now accepted receipt', async () => {
  let fail;
  const a = item('a'), props = { ...cardProps([a]), check: () => new Promise((_, reject) => { fail = reject; }) };
  const ui = mount('SubmittedQueryCards.tsx', props);
  try {
    button(row(ui.output, 'a'), '核对状态').props.onClick();
    ui.render({ ...props, items: [{ ...a, status: 'accepted' }] });
    fail(Error('Load failed')); await ui.flush();
    assert.deepEqual(alerts(ui.output), []);
  } finally { ui.close(); }
});

test('outbox check errors are per message, use GET only, and retire on revision or acceptance', async () => {
  const calls = [], a = queueItem('a'), b = queueItem('b'), props = queueProps([a, b]);
  const ui = mount('Outbox.tsx', props, async (path, method = 'GET') => { calls.push({ path, method }); throw Error(path.endsWith('/a') ? 'Fetch is aborted' : '提交记录不匹配，请重新核对。'); });
  try {
    for (const id of ['a', 'b']) { button(row(ui.output, id), '核对状态').props.onClick(); await ui.flush(); }
    assert.deepEqual(alerts(ui.output), ['连接暂时中断，请重试。', '提交记录不匹配，请重新核对。']);
    ui.render({ ...props, suppressNetworkErrors: true });
    assert.deepEqual(alerts(ui.output), ['提交记录不匹配，请重新核对。']);
    ui.render({ ...props, items: [{ ...a, revision: 1 }, b] });
    assert.deepEqual(alerts(ui.output), ['提交记录不匹配，请重新核对。']);
    ui.render({ ...props, items: [{ ...a, revision: 1 }, { ...b, status: 'accepted' }] });
    assert.deepEqual(alerts(ui.output), []);
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.equal(calls.length, 2);
    assert.equal(button(row(ui.output, 'a'), '删除第 1 条待发消息'), undefined);
  } finally { ui.close(); }
});

test('removing one outbox row drops only its error, including after the row returns', async () => {
  const a = queueItem('a'), b = queueItem('b'), props = queueProps([a, b]);
  const ui = mount('Outbox.tsx', props, async path => { throw Error(`核对 ${path.split('/').at(-1)} 失败`); });
  try {
    for (const id of ['a', 'b']) { button(row(ui.output, id), '核对状态').props.onClick(); await ui.flush(); }
    ui.render({ ...props, items: [b] }); ui.render(props);
    assert.deepEqual(alerts(ui.output), ['核对 b 失败']);
  } finally { ui.close(); }
});

test('a failed queue send binds its feedback to the shared unknown receipt before the parent catches up', async () => {
  const a = queueItem('a', 'queued'), submissions = queries.createSubmittedQueryStore(), calls = [];
  const props = { ...queueProps([a]), submissions };
  const ui = mount('Outbox.tsx', props, async (path, method) => { calls.push({ path, method }); throw Error('Load failed'); });
  try {
    button(row(ui.output, 'a'), '直接发送第 1 条消息').props.onClick(); await ui.flush();
    const items = queries.submittedOutbox(submissions.getThread('thread'), [], [a]);
    ui.render({ ...props, items });
    assert.equal(items[0].status, 'unknown');
    assert.deepEqual(alerts(ui.output), ['连接暂时中断，请重试。']);
    assert.equal(button(row(ui.output, 'a'), '直接发送第 1 条消息'), undefined);
    assert.equal(button(row(ui.output, 'a'), '删除第 1 条待发消息'), undefined);
    assert.deepEqual(calls, [{ path: '/api/tasks/thread/outbox/a/send', method: 'POST' }]);
    submissions.receipt('thread', { requestId: 'a', status: 'accepted' });
    ui.render({ ...props, items: queries.submittedOutbox(submissions.getThread('thread'), [], [a]) });
    assert.deepEqual(alerts(ui.output), []);
  } finally { ui.close(); }
});

test('inline submitted controls use the requested slot without duplicating text, files or copy actions', async () => {
  const a = { ...item('a'), attachments: [{ id: 'attachment' }] }, target = {}, calls = [];
  const props = { ...cardProps([a]), inlineTargets: new Map([['a', target]]), check: async value => { calls.push(value.requestId); } };
  const ui = mount('SubmittedQueryCards.tsx', props);
  try {
    const portal = nodes(ui.output).find(node => node.type === 'portal');
    assert.equal(portal.props.container, target);
    assert.equal(row(ui.output, 'a').props['data-submission-status'], 'unknown');
    assert.equal(nodes(ui.output).some(node => node.type === 'attachments'), false);
    assert.equal(nodes(ui.output).some(node => node.props?.className === 'submitted-query-copy'), false);
    assert.equal(nodes(ui.output).some(node => node.props?.text === a.text), false);
    button(row(ui.output, 'a'), '核对状态').props.onClick(); await ui.flush();
    assert.deepEqual(calls, ['a']);
    ui.render({ ...props, items: [] });
    assert.equal(row(ui.output, 'a'), undefined, 'inline removal retains no second exiting card');
  } finally { ui.close(); }
});

test('inline queue portals keep one controller and put pause recovery on the first available slot', async () => {
  const a = queueItem('a', 'unknown'), b = queueItem('b'), second = {}, calls = [];
  const props = { ...queueProps([a, b]), paused: { stopId: 'pause' }, inlineTargets: new Map([['b', second]]) };
  const ui = mount('Outbox.tsx', props, async (path, method, body) => { calls.push({ path, method, body }); throw Error('resume failed'); });
  try {
    assert.equal(row(ui.output, 'a'), undefined);
    assert.equal(nodes(ui.output).find(node => node.type === 'portal').props.container, second);
    assert.equal(nodes(ui.output).some(node => node.type === 'attachments' || node.props?.className === 'outbox-text' || node.props?.className === 'outbox-heading'), false);
    assert.equal(text(ui.output).includes(b.text), false);
    assert.equal(nodes(ui.output).filter(node => node.type === 'button' && text(node) === '恢复排队').length, 1);
    button(ui.output, '恢复排队').props.onClick(); await ui.flush();
    assert.equal(calls[0].path, '/api/tasks/thread/queue/resume');
    assert.equal(calls[0].body.expectedStopId, 'pause');
    assert.equal(alerts(row(ui.output, 'b')).length, 1);
  } finally { ui.close(); }
});

test('inline queue editing preserves server revision and drafts while rendering only its editor', async () => {
  const a = queueItem('a', 'queued', 0), calls = [], props = { ...queueProps([a]), inlineTargets: new Map([['a', {}]]) };
  const ui = mount('Outbox.tsx', props, async (path, method, body) => {
    calls.push({ path, method, body });
    return { outbox: [{ ...a, revision: path.endsWith('/edit') ? 1 : 2, status: path.endsWith('/edit') ? 'editing' : 'queued', text: body?.text ?? a.text }] };
  });
  try {
    button(ui.output, '编辑第 1 条待发消息').props.onClick(); await ui.flush();
    const editor = nodes(ui.output).find(node => node.type === 'textarea');
    assert.equal(editor.props.value, a.text);
    assert.equal(row(ui.output, 'a').props['data-query-editing'], true);
    assert.equal(nodes(ui.output).some(node => node.props?.className === 'outbox-text'), false);
    editor.props.onChange({ target: { value: 'Saved inline edit' } }); ui.render();
    assert.equal(props.drafts.get('thread/outbox/a').text, 'Saved inline edit');
    button(ui.output, '保存并排队').props.onClick(); await ui.flush();
    assert.equal(calls[1].method, 'PATCH');
    assert.equal(calls[1].body.expectedRevision, 1);
    assert.equal(calls[1].body.text, 'Saved inline edit');
    assert.equal(props.drafts.has('thread/outbox/a'), false);
  } finally { ui.close(); }
});
