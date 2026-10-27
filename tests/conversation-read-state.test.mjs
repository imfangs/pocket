import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyConversationState } from '../src/conversationReadState.ts';

const initial = {
  online: true, loading: true, transcriptLoading: true, historyFailed: false,
  messageCount: 0, submissionCount: 0, outboxCount: 0,
};

test('a first empty view indicates reading until both initial sources have settled', () => {
  assert.equal(emptyConversationState(initial), 'loading');
  assert.equal(emptyConversationState({ ...initial, loading: false }), 'loading', 'empty history cannot decide before transcript');
  assert.equal(emptyConversationState({ ...initial, transcriptLoading: false }), 'loading', 'empty transcript cannot decide before history');
});

test('a failed first source does not conceal the other source that is still reading', () => {
  assert.equal(emptyConversationState({ ...initial, loading: false, historyFailed: true }), 'loading');
});

test('either source providing messages immediately leaves the empty-view presentation', () => {
  for (const flags of [{ loading: true, transcriptLoading: false }, { loading: false, transcriptLoading: true }]) {
    assert.equal(emptyConversationState({ ...initial, ...flags, messageCount: 1 }), null);
  }
});

test('cached messages, submitted Queries and outbox Queries never get a loading or empty overlay', () => {
  for (const content of [{ messageCount: 2 }, { submissionCount: 1 }, { outboxCount: 1 }]) {
    for (const reads of [{ loading: true, transcriptLoading: true }, { loading: false, transcriptLoading: false }]) {
      assert.equal(emptyConversationState({ ...initial, ...content, ...reads }), null);
    }
  }
});

test('only settled successful reads show the genuine empty state', () => {
  assert.equal(emptyConversationState({ ...initial, loading: false, transcriptLoading: false }), 'empty');
  assert.equal(emptyConversationState({ ...initial, loading: false, transcriptLoading: false, historyFailed: true }), null,
    'existing read recovery owns failures');
});

test('offline reads never claim to be loading', () => {
  assert.equal(emptyConversationState({ ...initial, online: false }), null);
  assert.equal(emptyConversationState({ ...initial, online: false, loading: false }), null);
  assert.equal(emptyConversationState({ ...initial, online: false, loading: false, transcriptLoading: false, historyFailed: true }), null);
});
