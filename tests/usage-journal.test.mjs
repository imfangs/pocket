import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageJournal } from '../src/usageJournal.ts';

function fixture() {
  let time = 0, sequence = 0;
  const events = [];
  const journal = createUsageJournal({ now: () => time, id: () => `id-${++sequence}`, capture: (name, properties) => { events.push({ name, ...properties }); return true; } });
  return { journal, events, advance: ms => { time += ms; }, named: name => events.filter(event => event.name === name) };
}
test('background time is separate from foreground send latency', () => {
  const f = fixture(); f.journal.enable(true); f.journal.open('thread-a');
  f.journal.submit('thread-a', 'request', { action: 'send', mode: 'direct' });
  f.advance(100); f.journal.visibility(false); f.advance(60000); f.journal.visibility(true); f.advance(200);
  f.journal.receipt('thread-a', 'request', 'accepted');
  const receipt = f.named('pocket_submission_receipt')[0];
  assert.equal(receipt.elapsed_ms, 60300); assert.equal(receipt.foreground_ms, 300);
});
test('acceptance, visible echo and end of waiting are distinct and deduplicated', () => {
  const f = fixture(); f.journal.enable(true); f.journal.open('thread-a');
  f.journal.submit('thread-a', 'request', { action: 'send' });
  f.journal.receipt('thread-a', 'request', 'unknown');
  f.journal.receipt('thread-a', 'request', 'unknown');
  assert.equal(f.named('pocket_submission_visible').length, 0);
  f.journal.receipt('thread-a', 'request', 'accepted');
  f.journal.receipt('thread-a', 'request', 'queued');
  f.journal.messageVisible('thread-a', 'another-request');
  f.journal.messageVisible('another-thread', 'request');
  f.journal.visibility(false); f.journal.messageVisible('thread-a', 'request');
  assert.equal(f.named('pocket_submission_visible').length, 0);
  f.journal.visibility(true); f.journal.messageVisible('thread-a', 'request'); f.journal.messageVisible('thread-a', 'request');
  f.journal.waitEnded('thread-a', 'request', true); f.journal.waitEnded('thread-a', 'request', true);
  assert.deepEqual(f.named('pocket_submission_receipt').map(e => e.status), ['unknown', 'accepted']);
  assert.equal(f.named('pocket_submission_visible').length, 1);
  assert.equal(f.named('pocket_submission_wait_ended').length, 1);
});
test('late receipts keep their original visit; checks and old history do not create sends', () => {
  const f = fixture(); f.journal.enable(true);
  const first = f.journal.open('thread-a');
  f.journal.submit('thread-a', 'request', { action: 'send' });
  f.journal.close(first); f.journal.open('thread-b');
  f.journal.receipt('thread-a', 'request', 'accepted');
  f.journal.receipt('thread-a', 'old-request', 'accepted');
  f.journal.submit('thread-a', 'request', { action: 'check' });
  assert.equal(f.named('pocket_submission_started').length, 1);
  assert.equal(f.named('pocket_submission_receipt')[0].visit_id, first);
  assert.equal(f.named('pocket_submission_receipt').length, 1);
});
test('a late queued response cannot resurrect a cancelled submission', () => {
  const f = fixture(); f.journal.enable(true); f.journal.open('thread-a');
  f.journal.submit('thread-a', 'request', { action: 'send', mode: 'queue' });
  for (const status of ['queued', 'cancelled', 'queued', 'pending', 'accepted']) f.journal.receipt('thread-a', 'request', status);
  assert.deepEqual(f.named('pocket_submission_receipt').map(e => e.status), ['queued', 'cancelled']);
});
test('first visible content and input focus count once per actual visit', () => {
  const f = fixture(); f.journal.enable(true); const first = f.journal.open('thread-a');
  f.journal.visibility(false); f.journal.contentVisible('thread-a', 4);
  f.journal.visibility(true); f.journal.contentVisible('thread-a', 4); f.journal.contentVisible('thread-a', 5);
  f.journal.focus('thread-a'); f.journal.focus('thread-a');
  assert.equal(f.named('pocket_content_visible').length, 1); assert.equal(f.named('pocket_composer_focused').length, 1);
  f.journal.close('stale-visit'); assert.equal(f.named('pocket_conversation_closed').length, 0);
  f.journal.close(first, { draft_present: true });
  assert.equal(f.named('pocket_conversation_closed')[0].draft_present, true);
});
test('feedback marker and optional details share an ID without creating a message', () => {
  const f = fixture(); f.journal.enable(true); const visitId = f.journal.open('thread-a');
  const feedbackId = f.journal.feedback('thread-a');
  f.journal.feedbackDetails('thread-a', feedbackId, 'slow', '  等了很久  ');
  assert.equal(f.named('pocket_feedback_marked')[0].visit_id, visitId);
  assert.equal(f.named('pocket_feedback_details')[0].feedback_id, feedbackId);
  assert.equal(f.named('pocket_feedback_details')[0].note, '等了很久');
  assert.equal(f.named('pocket_submission_started').length, 0);
});
test('disabled collection and failed capture cannot throw into product actions', () => {
  const f = fixture(); assert.equal(f.journal.open('thread-a'), null); assert.equal(f.journal.feedback('thread-a'), null);
  f.journal.submit('thread-a', 'request', { action: 'send' }); assert.equal(f.events.length, 0);
  f.journal.enable(true); f.journal.open('thread-a'); f.journal.submit('thread-a', 'request', { action: 'send' });
  f.journal.enable(false); f.journal.enable(true); f.journal.receipt('thread-a', 'request', 'accepted');
  assert.equal(f.named('pocket_submission_receipt').length, 0, 'logout clears pending observation state');
  const bad = createUsageJournal({ capture: () => { throw new Error('SDK blocked'); } });
  bad.enable(true); assert.doesNotThrow(() => bad.open('thread-a')); assert.equal(bad.feedback('thread-a'), null);
});
