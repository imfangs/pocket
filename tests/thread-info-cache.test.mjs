import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadInfoCache, threadInfoCache, threadInfoCacheLimits } from '../src/threadInfoCache.ts';
import { createApiClient } from '../src/api.ts';

const key = { machine: 'ged', hostId: 'local', threadId: 'thread-one', kind: 'automations' };
const put = (cache, id, value) => cache.put(id, value, cache.ticket(id));

test('information is fresh for 30 seconds, readable for five minutes and does not renew on access', () => {
  let time = 1000;
  const cache = createThreadInfoCache({ now: () => time });
  assert.equal(put(cache, key, { plans: [] }), true);
  time += 29999;
  assert.deepEqual(cache.get(key), { value: { plans: [] }, savedAt: 1000, fresh: true });
  time++;
  assert.equal(cache.get(key).fresh, false);
  time = 301000;
  assert.equal(cache.get(key), null);
  time = 1000; put(cache, key, {}); time = 999;
  assert.equal(cache.get(key), null);
});

test('machine, source host, thread and information kind each isolate snapshots', () => {
  const cache = createThreadInfoCache();
  const keys = [key, { ...key, machine: 'wandou' }, { ...key, hostId: 'another-host' },
    { ...key, threadId: 'thread-two' }, { ...key, kind: 'models' }];
  keys.forEach((id, index) => put(cache, id, { index }));
  keys.forEach((id, index) => assert.deepEqual(cache.get(id).value, { index }));
});

test('returned and supplied objects cannot mutate a retained snapshot', () => {
  const cache = createThreadInfoCache(), value = { nested: { name: 'original' } };
  put(cache, key, value); value.nested.name = 'changed';
  const read = cache.get(key); read.value.nested.name = 'changed again';
  assert.equal(cache.get(key).value.nested.name, 'original');
});

test('per-item and per-machine invalidation reject responses from an earlier owner', () => {
  const cache = createThreadInfoCache(), other = { ...key, machine: 'wandou' };
  const ticket = cache.ticket(key), remote = cache.ticket(other);
  assert.equal(cache.put(key, {}, ticket), true);
  cache.remove(key);
  assert.equal(cache.current(key, ticket), false);
  assert.equal(cache.put(key, { stale: true }, ticket), false);
  const fresh = cache.ticket(key);
  cache.clear('ged');
  assert.equal(cache.put(key, {}, fresh), false);
  assert.equal(cache.put(other, {}, remote), true);
  cache.clear();
  assert.equal(cache.put(other, {}, remote), false);
});

test('entry count, bytes and outstanding owners remain bounded without resurrecting old tickets', () => {
  const cache = createThreadInfoCache();
  const first = cache.ticket(key);
  put(cache, key, {});
  for (let i = 0; i < threadInfoCacheLimits.entries; i++) put(cache, { ...key, threadId: `other-${i}` }, { index: i });
  assert.equal(cache.get(key), null);
  assert.equal(cache.current(key, first), false);
  cache.ticket(key);
  assert.equal(cache.current(key, first), false);
  const large = 'x'.repeat(threadInfoCacheLimits.bytes / 3);
  put(cache, { ...key, threadId: 'large-first' }, large);
  put(cache, { ...key, threadId: 'large-second' }, large);
  assert.equal(cache.get({ ...key, threadId: 'large-first' }), null);
  assert.equal(cache.get({ ...key, threadId: 'large-second' }).value.length, large.length);
  assert.equal(put(cache, key, 'x'.repeat(threadInfoCacheLimits.bytes)), false);
});

test('clear notifications are machine scoped, removable and cannot interrupt revocation', () => {
  const cache = createThreadInfoCache(), seen = [];
  const release = cache.subscribe(event => seen.push(event));
  cache.subscribe(() => { throw new Error('broken observer'); });
  put(cache, key, {}); cache.clear('ged');
  assert.deepEqual(seen, [{ machine: 'ged' }]);
  assert.equal(cache.get(key), null);
  release(); cache.clear();
  assert.equal(seen.length, 1);
});

test('API source and authentication invalidation clear information and its late-response tickets', () => {
  const client = createApiClient(() => 'ged');
  const other = { ...key, machine: 'wandou' };
  const initial = threadInfoCache.ticket(key);
  threadInfoCache.put(key, {}, initial); put(threadInfoCache, other, { retained: true });
  client.clearReadResponses('ged');
  assert.equal(threadInfoCache.get(key), null);
  assert.equal(threadInfoCache.current(key, initial), false);
  assert.deepEqual(threadInfoCache.get(other).value, { retained: true });
  const relogin = threadInfoCache.ticket(key); threadInfoCache.put(key, {}, relogin);
  client.invalidateAuthentication('ged');
  assert.equal(threadInfoCache.get(key), null);
  assert.equal(threadInfoCache.current(key, relogin), false);
  threadInfoCache.clear();
});
