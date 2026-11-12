import test from 'node:test';
import assert from 'node:assert/strict';
import { candidate, controlledFixture, flush, id, response } from './helpers/transcript-prefetch-benchmark.mjs';

test('sixteen offered candidates start eight producers and retain the fixed window without duplicate GETs', async () => {
  const items = Array.from({ length: 16 }, (_, n) => candidate(n + 1));
  const f = controlledFixture({ latency: () => 1000 });
  f.update(items); await f.advance(750);
  assert.equal(f.active(), 8); assert.equal(f.requests.length, 8); assert.equal(f.loads.length, 8);
  f.update(structuredClone(items)); await f.advance(10000);
  assert.equal(f.peak(), 8); assert.equal(f.writes.length, 8); assert.equal(f.requests.length, 8);
  assert.deepEqual(f.requests.map(item => item.threadId), items.slice(0, 8).map(item => item.id));
  f.reader.stop(); assert.equal(f.timers.size, 0);
});

test('a foreground read dispatches immediately through eight mixed slow background reads', async () => {
  const items = Array.from({ length: 8 }, (_, n) => candidate(n + 1));
  const f = controlledFixture({ latency: threadId => threadId === id(99) ? 50 : Number(threadId.slice(-12)) * 1000 });
  f.update(items); await f.advance(750); assert.equal(f.active(), 8);
  const at = f.now(), reading = f.reader.read(id(99), new AbortController().signal); await flush();
  assert.ok(f.requests.slice(0, 8).every(item => item.aborted), 'only background GETs yield the budget');
  assert.equal(f.requests[8].at, at); await f.advance(50); await reading;
  assert.equal(f.requests[8].completedAt - at, 50); assert.equal(f.requests.length, 9);
  await f.advance(1900); assert.equal(f.requests.length, 9, 'eight aborts count as one queue cooldown');
  await f.advance(50); assert.equal(f.requests.length, 17, 'one preemption resumes eight lanes after two seconds');
  f.reader.stop(); await flush(); assert.equal(f.active(), 0); assert.equal(f.timers.size, 0);
});

test('foreground adoption survives cancelling the other lanes, hidden cleanup, and a background deadline', async () => {
  const items = Array.from({ length: 8 }, (_, n) => candidate(n + 1));
  const f = controlledFixture({ latency: () => 3000, timeoutMs: 1000 });
  f.update(items); await f.advance(750); f.selected(items[2].id);
  const reading = f.reader.read(items[2].id, new AbortController().signal); await flush();
  assert.equal(f.requests.length, 8); assert.equal(f.requests[2].aborted, false);
  assert.ok(f.requests.filter((_, n) => n !== 2).every(item => item.aborted));
  f.enabled(false); f.reader.wake(true); f.update([], { enabled: false }); await f.advance(1000);
  assert.equal(f.requests[2].aborted, false); assert.equal(f.active(), 1);
  await f.advance(2000); assert.deepEqual(await reading, response(items[2]));
  assert.equal(f.writes.length, 0); f.reader.stop(); assert.equal(f.timers.size, 0);
});

test('eight running lanes validate the full working set before repeating at five-second cadence', async () => {
  const items = Array.from({ length: 8 }, (_, n) => candidate(n + 1, 1, 'running'));
  const f = controlledFixture({ latency: () => 100, gapMs: 10 });
  f.update(items); await f.advance(250);
  assert.equal(f.writes.length, 8); assert.equal(f.peak(), 8);
  assert.deepEqual(f.requests.map(item => item.threadId), items.map(item => item.id));
  await f.advance(5000);
  assert.equal(f.requests.length, 16);
  assert.deepEqual(f.requests.slice(8).map(item => item.threadId), items.map(item => item.id));
  for (let n = 0; n < 8; n++) assert.ok(f.requests[n + 8].at - f.requests[n].completedAt >= 5000);
  f.enabled(false); f.reader.wake(true); await f.advance(30000); assert.equal(f.requests.length, 16);
  f.reader.stop(); assert.equal(f.timers.size, 0);
});

test('a slow second validation cannot hold free lanes past the other running candidates due times', async () => {
  const items = Array.from({ length: 8 }, (_, n) => candidate(n + 1, 1, 'running')), starts = new Map();
  const f = controlledFixture({ gapMs: 10, latency: threadId => {
    const count = (starts.get(threadId) ?? 0) + 1; starts.set(threadId, count);
    return count === 1 ? Number(threadId.slice(-12)) * 100 : 10000;
  } });
  f.update(items); await f.advance(5900);
  assert.equal(f.requests.length, 16, 'each due candidate can use a free slot while the earlier one remains slow');
  for (let n = 0; n < 8; n++) assert.equal(f.requests[n + 8].at - f.requests[n].completedAt, 5000);
  assert.equal(f.active(), 8); f.reader.stop(); await flush(); assert.equal(f.timers.size, 0);
});

test('one changed candidate cancels only its lane and concurrent bodies cannot lower the validated floor', async () => {
  const items = Array.from({ length: 8 }, (_, n) => candidate(n + 1, 1, 'running'));
  const f = controlledFixture({ latency: () => 10000, gapMs: 10 });
  f.update(items); await f.advance(10); assert.equal(f.requests.length, 8);
  f.requests[0].resolve(response(candidate(1, 3))); await flush();
  const changed = [candidate(1, 2, 'running'), candidate(2, 2, 'running'), ...items.slice(2)];
  f.update(changed); await f.advance(10);
  assert.equal(f.requests[1].aborted, true); assert.ok(f.requests.slice(2, 8).every(item => !item.aborted));
  const newest = f.requests.filter(item => !item.aborted && item.completedAt === null);
  assert.equal(newest.length, 8); assert.equal(new Set(newest.map(item => item.threadId)).size, 8);
  newest.find(item => item.threadId === id(1)).resolve(response(candidate(1, 2)));
  newest.find(item => item.threadId === id(2)).resolve(response(candidate(2, 2)));
  await flush(); assert.deepEqual(f.writes.filter(item => item.threadId === id(1)).map(item => item.data.pocketContent.revision), [3]);
  assert.equal(f.writes.find(item => item.threadId === id(2)).data.pocketContent.revision, 2);
  f.reader.stop(); await flush(); assert.equal(f.active(), 0); assert.equal(f.timers.size, 0);
});

test('hidden and identity cleanup abort all eight background lanes and reject their late bodies', async () => {
  for (const invalidate of [false, true]) {
    const f = controlledFixture({ latency: () => 10000 });
    f.update(Array.from({ length: 8 }, (_, n) => candidate(n + 1))); await f.advance(750);
    assert.equal(f.active(), 8);
    if (invalidate) { f.identity(false); f.reader.stop(); } else { f.enabled(false); f.reader.wake(true); }
    await flush(); assert.equal(f.active(), 0); assert.ok(f.requests.every(item => item.aborted));
    for (const request of f.requests) request.resolve(response(candidate(Number(request.threadId.slice(-12)))));
    await f.advance(30000); assert.equal(f.writes.length, 0); assert.equal(f.requests.length, 8);
    f.reader.stop(); assert.equal(f.timers.size, 0);
  }
});
