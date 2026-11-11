import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSubmissionReceipt, submissionTransportLimits } from '../src/submissionTransport.ts';
import { createSubmittedQueryStore, withSubmittedQueryPost } from '../src/submittedQueries.ts';

const accepted = { requestId: 'request', status: 'accepted' };
const stalled = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
const timeoutError = () => new DOMException('Synthetic response deadline', 'TimeoutError');

test('a post owns its response deadline and survives navigation without replaying the submitted request', async () => {
  const view = new AbortController(), deadline = new AbortController();
  let signal, calls = 0, budget;
  const request = requestSubmissionReceipt('request', current => { calls++; signal = current; return stalled(current); },
    { kind: 'post', viewSignal: view.signal, timeout: ms => { budget = ms; return deadline.signal; } });
  view.abort(); assert.equal(signal.aborted, false, 'Leaving the reading page does not cancel a submitted POST');
  deadline.abort(timeoutError()); await assert.rejects(request, { name: 'TimeoutError' });
  assert.equal(calls, 1); assert.equal(budget, submissionTransportLimits.postMs);
});

test('a legacy receipt GET uses its shorter deadline and remains cancellable by the current view', async () => {
  const view = new AbortController(), deadline = new AbortController();
  let budget, signal;
  const request = requestSubmissionReceipt('request', current => { signal = current; return stalled(current); },
    { kind: 'read', viewSignal: view.signal, timeout: ms => { budget = ms; return deadline.signal; } });
  view.abort(); await assert.rejects(request, { name: 'AbortError' });
  assert.equal(signal.aborted, true); assert.equal(budget, submissionTransportLimits.readMs);
});

test('a cancelled view before dispatch makes no request and a reply with another identity is never admitted', async () => {
  const view = new AbortController(); view.abort(); let calls = 0;
  await assert.rejects(requestSubmissionReceipt('request', async () => { calls++; return accepted; }, { kind: 'post', viewSignal: view.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(requestSubmissionReceipt('request', async () => ({ requestId: 'another', status: 'accepted' }),
    { kind: 'post', viewSignal: new AbortController().signal, timeout: () => new AbortController().signal }), /不匹配/);
});

test('timeout retains the unknown original body and later native acceptance wins over a late transport failure', async () => {
  const store = createSubmittedQueryStore(), deadline = new AbortController();
  store.seed({ threadId: 'thread', requestId: 'request', text: 'Immutable original query', status: 'submitting' });
  const post = withSubmittedQueryPost(store, 'thread', 'request', () => requestSubmissionReceipt('request', stalled,
    { kind: 'post', viewSignal: new AbortController().signal, timeout: () => deadline.signal }));
  deadline.abort(timeoutError()); await assert.rejects(post, { name: 'TimeoutError' });
  store.receipt('thread', { requestId: 'request', status: 'unknown' });
  assert.equal(store.getThread('thread')[0].text, 'Immutable original query');
  assert.equal(store.getThread('thread')[0].status, 'unknown');
  store.receipt('thread', accepted); store.receipt('thread', { requestId: 'request', status: 'unknown' });
  assert.equal(store.getThread('thread')[0].status, 'accepted');
  assert.equal(store.getThread('thread')[0].requestId, 'request');
});

test('a transport ignoring abort cannot relabel its late reply as a fresh response', async () => {
  const deadline = new AbortController(); let reply;
  const request = requestSubmissionReceipt('request', () => new Promise(resolve => { reply = resolve; }),
    { kind: 'post', viewSignal: new AbortController().signal, timeout: () => deadline.signal });
  deadline.abort(timeoutError()); reply(accepted);
  await assert.rejects(request, { name: 'TimeoutError' });
});
