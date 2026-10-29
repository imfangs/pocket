import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestActivity } from '../src/requestActivity.ts';

const a = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const begin = (store, path, method = 'GET', body) => store.begin({ machine: 'ged', path, method, body });

test('overlapping request tokens stay pending independently and finish is idempotent', () => {
  const store = createRequestActivity(), states = [];
  const stop = store.subscribe(() => states.push(store.isPending('ged', a)));
  const first = begin(store, `/api/tasks/${a}/history`), second = begin(store, `/api/tasks/${a}/transcript`);
  assert.equal(store.isPending('ged'), true); assert.equal(store.isPending('ged', a), true);
  assert.equal(store.isPending('ged', b), false); assert.equal(store.isPending('wandou'), false);
  first(); first(); assert.equal(store.isPending('ged', a), true);
  second(); second(); assert.equal(store.isPending('ged'), false);
  assert.deepEqual(states, [true, true, true, false]);
  stop(); const last = begin(store, `/api/tasks/${a}/history`); last(); assert.equal(states.length, 4);
});

test('catalog and real directory changes also light a selected detail', () => {
  const store = createRequestActivity();
  for (const [path, method] of [['/api/catalog', 'GET'], ['/api/sync', 'POST'], ['/api/import', 'POST'], ['/api/groups/example', 'PATCH']]) {
    const finish = begin(store, path, method);
    assert.equal(store.isPending('ged', a), true, path); assert.equal(store.isPending('ged', b), true, path);
    assert.equal(store.isPending('wandou', a), false, path); finish();
  }
});

test('status priority hints and lifecycle request IDs never pretend to be a detail scope', () => {
  const store = createRequestActivity();
  const body = new Proxy({}, { get() { throw new Error('observer must not inspect request bodies'); } });
  for (const [path, method] of [[`/api/task-statuses?priorityThreadIds=${a},${b}`, 'GET'], ['/api/task-statuses', 'POST'],
    ['/api/tasks', 'POST'], ['/api/tasks/create-options', 'GET'], [`/api/task-operations/${a}`, 'GET'],
    [`/api/task-operations/${a}/cancel`, 'POST'], ['/api/future-business-route', 'GET']]) {
    const finish = begin(store, path, method, body);
    assert.equal(store.isPending('ged'), true, path);
    assert.equal(store.isPending('ged', a), false, path); assert.equal(store.isPending('ged', b), false, path); finish();
  }
});

test('thread routes include opens, JSON attachment state and raw upload business requests', () => {
  const store = createRequestActivity();
  for (const [path, method] of [[`/api/open/${a}`, 'POST'], [`/api/tasks/${a}`, 'PATCH'],
    [`/api/tasks/${a}/messages/${b}`, 'GET'], [`/api/tasks/${a}/transcript-page?before=secret-cursor`, 'GET'],
    [`/api/tasks/${a}/attachments`, 'GET'], [`/api/tasks/${a}/attachments/${b}?metadata=1`, 'GET'],
    [`/api/tasks/${a}/attachments/${b}?name=private-name.png`, 'PUT'], [`/api/tasks/${a}/attachments/${b}`, 'DELETE']]) {
    const finish = begin(store, path, method, { text: 'private input', csrfToken: 'secret' });
    assert.equal(store.isPending('ged', a), true, path); assert.equal(store.isPending('ged', b), false, path); finish();
  }
});

test('auth, notifications, feedback, static assets and media reads do not start activity', () => {
  const store = createRequestActivity(); let notified = 0; store.subscribe(() => notified++);
  for (const [path, method] of [['/api/auth/status', 'GET'], ['/api/auth/login', 'POST'], ['/api/auth/logout', 'POST'],
    ['/api/health', 'GET'], ['/api/notifications/subscription', 'POST'], ['/api/feedback', 'POST'], ['/api/feedback/config', 'GET'],
    [`/api/tasks/${a}/files/${'a'.repeat(64)}?video=1`, 'GET'], [`/api/tasks/${a}/images/${'a'.repeat(64)}`, 'GET'],
    [`/api/tasks/${a}/attachments/${b}?preview=1`, 'GET'], ['/assets/app.js', 'GET'], ['https://elsewhere.test/api/catalog', 'GET']]) {
    begin(store, path, method)(); assert.equal(store.isPending('ged'), false, path);
  }
  assert.equal(notified, 0);
});

test('clearing one machine cannot let an old completion erase a newer request or another machine', () => {
  const store = createRequestActivity(), old = begin(store, `/api/tasks/${a}/messages`, 'POST');
  const remote = store.begin({ machine: 'wandou', path: '/api/catalog', method: 'GET' });
  store.clearMachine('ged'); assert.equal(store.isPending('ged'), false); assert.equal(store.isPending('wandou'), true);
  const next = begin(store, `/api/tasks/${a}/messages`, 'POST'); old(); old();
  assert.equal(store.isPending('ged', a), true);
  remote(); assert.equal(store.isPending('wandou'), false); next();
  assert.equal(store.isPending('ged'), false);
});

test('throwing subscribers cannot block other observers or leave activity stuck', () => {
  const store = createRequestActivity(), seen = [];
  store.subscribe(() => { throw new Error('observer failure'); });
  store.subscribe(() => seen.push(store.isPending('ged')));
  const finish = begin(store, '/api/catalog'); finish(); finish();
  begin(store, '/api/catalog'); store.clearMachine('ged');
  assert.deepEqual(seen, [true, false, true, false]); assert.equal(store.isPending('ged'), false);
});
