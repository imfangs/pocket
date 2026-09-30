import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSubmission } from '../src/submissionReceipt.ts';
const receipt=status=>({requestId:'one',status});
test('pending receipts settle by reads only and stop at a terminal/unknown result',async()=>{
  let reads=0;
  const result=await waitForSubmission(receipt('pending'),async()=>receipt(++reads===2?'accepted':'pending'),new AbortController().signal,{intervalMs:1,maxWaitMs:1000});
  assert.equal(result.status,'accepted');assert.equal(reads,2);
  reads=0;
  const unknown=await waitForSubmission(receipt('unknown'),async()=>{reads++;return receipt('accepted');},new AbortController().signal);
  assert.equal(unknown.status,'unknown');assert.equal(reads,0);
});
test('leaving stops receipt reads and mismatched receipts cannot clear another draft',async()=>{
  const controller=new AbortController();let reads=0;
  const waiting=waitForSubmission(receipt('pending'),async()=>{reads++;return receipt('accepted');},controller.signal);
  controller.abort();await assert.rejects(waiting);assert.equal(reads,0);
  await assert.rejects(waitForSubmission(receipt('pending'),async()=>({requestId:'another',status:'accepted'}),new AbortController().signal,{intervalMs:1,maxWaitMs:1000}),/不匹配/);
});
test('leaving before the original HTTP response arrives ignores even a terminal receipt',async()=>{
  const controller=new AbortController();controller.abort();let reads=0;
  for(const status of ['accepted','queued','rejected','unknown']) {
    await assert.rejects(waitForSubmission(receipt(status),async()=>{reads++;return receipt('accepted');},controller.signal),{name:'AbortError'});
  }
  assert.equal(reads,0);
});
test('leaving during a receipt read rejects its late result and keeps the request available to a new view',async()=>{
  const controller=new AbortController();let finish,started;
  const reading=new Promise(resolve=>{started=resolve;});
  const waiting=waitForSubmission(receipt('pending'),()=>{started();return new Promise(resolve=>{finish=resolve;});},controller.signal,{intervalMs:1,maxWaitMs:1000});
  await reading;controller.abort();finish(receipt('accepted'));
  await assert.rejects(waiting,{name:'AbortError'});
  let reads=0;
  const checked=await waitForSubmission(receipt('pending'),async()=>{reads++;return receipt('accepted');},new AbortController().signal,{intervalMs:1,maxWaitMs:1000});
  assert.equal(checked.requestId,'one');assert.equal(checked.status,'accepted');assert.equal(reads,1);
});
