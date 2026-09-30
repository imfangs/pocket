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
