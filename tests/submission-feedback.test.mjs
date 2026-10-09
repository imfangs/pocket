import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionFeedbackTracker, queueFeedbackState, queueHeadState, SEND_FEEDBACK_MS } from '../src/submissionFeedback.ts';

test('only an accepted receipt produces immediate green feedback, independently of a history echo', () => {
  const tracker = createSubmissionFeedbackTracker(() => 1000);
  for (const status of ['queued', 'pending', 'unknown', 'rejected', 'not_found']) assert.equal(tracker.accept({ requestId: status, status }), null);
  assert.deepEqual(tracker.accept({ requestId: 'sent', status: 'accepted' }), { requestId: 'sent', source: 'composer', expiresAt: 1000 + SEND_FEEDBACK_MS });
  assert.equal(tracker.accept({ requestId: 'sent', status: 'accepted' }), null, 'checking the same accepted receipt must not replay the animation');
});
test('only a queue item observed in this view can be confirmed by its exact native history echo', () => {
  const tracker = createSubmissionFeedbackTracker(() => 1000);
  const message = { id: 'native-message', role: 'user', clientMessageId: 'queued-id', text: 'Queued text' };
  assert.deepEqual(tracker.observeHistory({ source: 'desktop', messages: [message], outbox: [] }), [], 'reopening old history must not celebrate');
  tracker.observeHistory({ source: 'rollout', messages: [], outbox: [{ id: 'queued-id', status: 'queued' }] });
  assert.deepEqual(tracker.observeHistory({ source: 'rollout', messages: [message], outbox: [] }), [], 'saved text is not a native acceptance');
  assert.deepEqual(tracker.observeHistory({ source: 'desktop', messages: [{ ...message, clientMessageId: 'different' }], outbox: [] }), []);
  assert.equal(tracker.observeHistory({ source: 'desktop', messages: [message], outbox: [] })[0].source, 'queue');
  assert.deepEqual(tracker.observeHistory({ source: 'desktop', messages: [message], outbox: [] }), []);
});
test('removing a queue item does not imply successful delivery', () => {
  const tracker = createSubmissionFeedbackTracker();
  tracker.observeHistory({ source: 'desktop', messages: [], outbox: [{ id: 'deleted', status: 'queued' }] });
  assert.deepEqual(tracker.observeHistory({ source: 'desktop', messages: [], outbox: [] }), []);
});
test('a queued receipt can connect to an early native echo without waiting for an outbox render', () => {
  let now = 10;
  const tracker = createSubmissionFeedbackTracker(() => now);
  tracker.trackQueued('fast-queue');
  const confirmed = tracker.observeHistory({ source: 'desktop', messages: [{ role: 'user', clientMessageId: 'fast-queue' }], outbox: [] });
  assert.equal(confirmed[0].requestId, 'fast-queue');
  assert.equal(tracker.hasAccepted('fast-queue'), true, 'a late queued HTTP response must not downgrade this acceptance');
  now += SEND_FEEDBACK_MS + 1000;
  assert.equal(tracker.accept({ requestId: 'fast-queue', status: 'accepted' }), null, 'expiry does not permit an old receipt to replay');
});
test('waiting queue breathes blue while paused, edited, uncertain and failed items stay static', () => {
  assert.deepEqual(queueFeedbackState({ status: 'queued' }), { state: 'queued', breathing: true });
  for (const options of [{ paused: true }, { editing: true }, { busy: true }, { disabled: true }, { headBlocked: true }]) assert.equal(queueFeedbackState({ status: 'queued' }, options).breathing, false);
  for (const status of ['pending', 'editing', 'unknown', 'rejected', 'accepted']) assert.equal(queueFeedbackState({ status }).breathing, false);
  assert.equal(queueFeedbackState({ status: 'unknown' }, { paused: true }).state, 'unknown');
  assert.equal(queueFeedbackState({ status: 'rejected' }, { paused: true }).state, 'rejected');
  assert.equal(queueFeedbackState({ status: 'accepted' }).state, 'accepted');
  assert.deepEqual(queueFeedbackState({ status: 'queued' }, { accepted: true }), { state: 'accepted', breathing: false }, 'a confirmed receipt takes precedence over a slow outbox refresh');
});
test('a locally paused first item stops following rows before slow history catches up', () => {
  const head = { id: 'head', status: 'queued' };
  const state = queueHeadState(head, 'head');
  assert.deepEqual(state, { editing: true, blocked: true });
  assert.equal(queueFeedbackState({ status: 'queued' }, { headBlocked: state.blocked }).breathing, false);
  assert.deepEqual(queueHeadState(head, 'later-item'), { editing: false, blocked: false });
});
