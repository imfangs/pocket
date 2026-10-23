import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogReader} from '../src/catalogReader.ts';

function fixture() {
  const pending=[],shown=[],settled=[];
  const reader=createCatalogReader({request:sync=>new Promise((resolve,reject)=>pending.push({sync,resolve,reject})),onData:data=>shown.push(data),onSettled:error=>settled.push(error?.message||'ready')});
  return {reader,pending,shown,settled};
}
test('foreground sync finishes loading without waiting for an old initial catalog',async()=>{
  const f=fixture(),old=f.reader.read(),fresh=f.reader.read(true);
  f.pending[1].resolve({version:'fresh'});await fresh;
  assert.deepEqual(f.shown,[{version:'fresh'}]);assert.deepEqual(f.settled,['ready']);
  f.pending[0].resolve({version:'old'});assert.equal(await old,undefined);
  assert.deepEqual(f.shown,[{version:'fresh'}]);assert.deepEqual(f.settled,['ready']);
});
test('a stale failed read cannot show an error after recovery; a current failure can retry',async()=>{
  const f=fixture(),old=f.reader.read(),fresh=f.reader.read(true);
  f.pending[1].resolve({version:'fresh'});await fresh;
  f.pending[0].reject(new Error('stale network error'));await old;
  assert.deepEqual(f.settled,['ready']);
  const failed=f.reader.read(true);f.pending[2].reject(new Error('offline'));await assert.rejects(failed,/offline/);
  const retry=f.reader.read(true);f.pending[3].resolve({version:'recovered'});await retry;
  assert.deepEqual(f.settled,['ready','offline','ready']);
});
test('successful local edits invalidate older snapshots, and unmount ignores pending work',async()=>{
  const f=fixture(),old=f.reader.read(true);f.reader.invalidate();
  f.pending[0].resolve({note:'old'});await old;assert.deepEqual(f.shown,[]);
  const leaving=f.reader.read();f.reader.pause();f.pending[1].resolve({version:'old session'});await leaving;
  await f.reader.read();assert.equal(f.pending.length,2);assert.deepEqual(f.settled,[]);
  f.reader.resume();const next=f.reader.read();f.pending[2].resolve({version:'new session'});await next;
  assert.deepEqual(f.shown,[{version:'new session'}]);
});

test('retry enters pending before its request and clears pending after either result', async () => {
  const events = [], pending = [];
  const reader = createCatalogReader({
    request: () => { events.push('request'); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    onPendingChange: value => events.push(value ? 'reading' : 'idle'),
    onData: () => events.push('data'), onSettled: error => events.push(error ? 'failure' : 'success'),
  });
  const first = reader.read();
  assert.deepEqual(events, ['reading', 'request']);
  pending[0].reject(new Error('timeout')); await assert.rejects(first, /timeout/);
  assert.deepEqual(events.slice(-2), ['failure', 'idle']);
  const retry = reader.read(true);
  assert.deepEqual(events.slice(-2), ['reading', 'request']);
  pending[1].resolve({ threads: [], sourceError: null }); await retry;
  assert.deepEqual(events.slice(-3), ['data', 'success', 'idle']);
});

test('HTTP success with a source failure retains its snapshot but never reports refresh success', async () => {
  const events = [], cached = { threads: [{ id: 'retained' }], sourceError: 'source unavailable' };
  const reader = createCatalogReader({ request: async () => cached,
    onData: data => events.push(data), onSettled: error => events.push(error ? 'failure' : 'success') });
  await assert.rejects(reader.read(true), /暂时无法更新/);
  assert.deepEqual(events, [cached, 'failure']);
});

test('invalidation and pause release pending without a late request hiding a newer refresh', async () => {
  const pending = [], events = [];
  const reader = createCatalogReader({ request: () => new Promise(resolve => pending.push(resolve)),
    onPendingChange: value => events.push(value), onData() {}, onSettled() {} });
  const first = reader.read(); reader.invalidate();
  assert.deepEqual(events, [true, false]);
  const second = reader.read(true);
  pending[0]({}); await first;
  assert.deepEqual(events, [true, false, true]);
  reader.pause(); pending[1]({}); await second;
  assert.deepEqual(events, [true, false, true, false]);
});
