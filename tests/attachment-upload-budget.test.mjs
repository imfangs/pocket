import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { createAttachmentDraftController, attachmentPath } from '../src/attachments.ts';

const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged' },
});

async function uploadFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch, calls = [], drafts = new Map([[threadId, { text: 'Original draft' }]]);
  const file = new File(['Synthetic upload bytes'], 'budget.txt', { type: 'text/plain' });
  let began, complete;
  const started = new Promise(resolve => { began = resolve; });
  globalThis.fetch = (url, init) => {
    const path = new URL(url, 'https://pocket.test'), call = { path: path.pathname, method: init.method, signal: init.signal };
    calls.push(call);
    if (init.method === 'GET' && path.searchParams.get('metadata') === '1')
      return Promise.resolve(response({ error: 'Synthetic upload not found' }, 404));
    assert.equal(init.method, 'PUT'); assert.equal(init.body, file, 'The real default transport keeps the selected File');
    assert.equal(path.searchParams.get('name'), file.name);
    const id = path.pathname.split('/').at(-1);
    const receipt = { id, name: file.name, size: file.size, mime: file.type, kind: 'file',
      sha256: createHash('sha256').update('Synthetic upload bytes').digest('hex'), url: attachmentPath(threadId, id) };
    return new Promise((resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      complete = () => { init.signal.removeEventListener('abort', abort); resolve(response(receipt)); };
      if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      began(call);
    });
  };
  const controller = createAttachmentDraftController(drafts);
  const [id] = controller.add(threadId, [file]);
  const put = await started;
  t.after(async () => { complete?.(); await setImmediate(); globalThis.fetch = original; });
  const status = expected => new Promise(resolve => {
    const stop = controller.subscribe(threadId, () => {
      if (controller.get(threadId)[0]?.status === expected) { stop(); resolve(); }
    });
    if (controller.get(threadId)[0]?.status === expected) { stop(); resolve(); }
  });
  return { controller, drafts, file, id, put, calls, complete: () => complete(), status };
}

test('the actual default attachment upload can exceed the ordinary 25s API budget and still finish once', async t => {
  const f = await uploadFixture(t);
  t.mock.timers.tick(30000);
  assert.equal(f.put.signal.aborted, false, 'A slow upload must keep its existing 190s budget');
  assert.equal(f.controller.get(threadId)[0].status, 'uploading');
  f.drafts.set(threadId, { ...f.drafts.get(threadId), text: 'A newer draft during the slow upload' });
  const uploaded = f.status('uploaded'); f.complete(); await uploaded;
  assert.equal(f.controller.get(threadId)[0].attachment.id, f.id);
  assert.equal(f.drafts.get(threadId).text, 'A newer draft during the slow upload');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  t.mock.timers.tick(190000);
  assert.equal(f.put.signal.aborted, false, 'The settled API deadline is disposed instead of aborting an old completed upload');
});

test('the actual 190s upload budget stays bounded and keeps an unknown file without replaying the PUT', async t => {
  const f = await uploadFixture(t);
  t.mock.timers.tick(189999); assert.equal(f.put.signal.aborted, false);
  const unknown = f.status('unknown'); t.mock.timers.tick(1); await unknown;
  assert.equal(f.put.signal.aborted, true); assert.equal(f.put.signal.reason.name, 'TimeoutError');
  assert.equal(f.controller.get(threadId)[0].id, f.id); assert.equal(f.controller.get(threadId)[0].file, f.file);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 1, 'A lost upload response permits only metadata readback');
});
