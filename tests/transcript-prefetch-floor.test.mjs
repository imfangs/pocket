import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptReader } from '../src/transcriptReader.ts';
import { candidate, controlledFixture, flush, id, response } from './helpers/transcript-prefetch-benchmark.mjs';

const validate = async (f, item, body = item) => {
  const before = f.requests.length; f.update([item]); await f.advance(10);
  assert.equal(f.requests.length, before + 1);
  f.requests.at(-1).resolve(response(body)); await flush();
};
const revisions = (f, n) => f.writes.filter(item => item.threadId === id(n)).map(item => item.data.pocketContent.revision);

test('a validated floor survives ranking out of the eight-candidate window with an evicted body', async () => {
  const f = controlledFixture({ gapMs: 10, latency: () => 10000 });
  await validate(f, candidate(1, 1, 'running'), candidate(1, 3));
  f.update(Array.from({ length: 8 }, (_, n) => candidate(n + 10))); await f.advance(10);
  await validate(f, candidate(1, 2, 'running'));
  assert.deepEqual(revisions(f, 1), [3], 'an older directory cannot lower a previously validated body after a rank change');
  f.reader.stop(); await flush(); assert.equal(f.timers.size, 0);
});

test('a selected view retains its floor through body eviction and permits a genuinely higher version', async () => {
  const f = controlledFixture({ gapMs: 10, latency: () => 10000 });
  await validate(f, candidate(1, 1, 'running'), candidate(1, 3));
  f.selected(id(1)); f.update([candidate(1, 2), candidate(2)]); await f.advance(10);
  f.selected(null); await validate(f, candidate(1, 2, 'running'));
  assert.deepEqual(revisions(f, 1), [3]);
  await validate(f, candidate(1, 4, 'running'));
  assert.deepEqual(revisions(f, 1), [3, 4]); f.reader.stop(); await flush();
});

test('the 256-entry floor ledger evicts the least recently used metadata and retains a touched floor', async () => {
  const f = controlledFixture({ gapMs: 10, latency: () => 10000 });
  for (let n = 1; n <= 256; n++) await validate(f, candidate(n), candidate(n, 3));
  // The 256th slot must still retain #1. Touching it makes #2 the oldest.
  await validate(f, candidate(1, 2)); assert.deepEqual(revisions(f, 1), [3]);
  await validate(f, candidate(257), candidate(257, 3));
  await validate(f, candidate(2, 2)); assert.deepEqual(revisions(f, 2), [3, 2], 'entry 257 evicts the oldest metadata only');
  await validate(f, candidate(1, 2)); assert.deepEqual(revisions(f, 1), [3], 'the recently touched floor survives LRU eviction');
  await validate(f, candidate(256, 2)); assert.deepEqual(revisions(f, 256), [3]);
  f.reader.stop(); await flush(); assert.equal(f.timers.size, 0);
});

test('owner invalidation clears the ledger, a new source owns an independent floor, and stop rejects late reads', async () => {
  const f = controlledFixture({ gapMs: 10, latency: () => 10000 });
  await validate(f, candidate(1), candidate(1, 3)); f.update([]);
  f.identity(false); assert.equal(f.reader.available(), false); f.identity(true);
  await validate(f, candidate(1, 2)); assert.deepEqual(revisions(f, 1), [3, 2], 'observed owner invalidation releases old metadata');
  const other = controlledFixture({ gapMs: 10, latency: () => 10000,
    createReader: options => createTranscriptReader({ ...options, scope: 'other-scope' }) });
  const item = { ...candidate(1), content: { ...candidate(1).content, scope: 'other-scope' } };
  await validate(other, item); assert.deepEqual(revisions(other, 1), [1], 'a new source cannot inherit the old owner floor');
  const reading = other.reader.read(id(99), new AbortController().signal); await flush();
  const rejected = assert.rejects(reading, { name: 'AbortError' }); other.reader.stop(); await rejected;
  other.requests.at(-1).resolve(response(candidate(99))); await flush();
  assert.equal(other.writes.length, 1); assert.equal(other.timers.size, 0); f.reader.stop(); await flush();
});
