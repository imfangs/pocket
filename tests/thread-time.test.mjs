import test from 'node:test';
import assert from 'node:assert/strict';
import {lastMessageTime} from '../src/threadTime.ts';
test('message labels never substitute settings, creation or visit times',()=>{
  const message=1700000000000;
  assert.equal(lastMessageTime({lastMessageAt:message,updatedAt:message+100000}),message);
  for(const lastMessageAt of [undefined,null,0,-1,NaN,Infinity,Number.MAX_VALUE,'1700000000000'])
    assert.equal(lastMessageTime({lastMessageAt,updatedAt:message,createdAt:message,lastOpenedAt:message}),null);
});
