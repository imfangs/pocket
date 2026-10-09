import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuickCreate } from '../src/quickCreate.ts';
import { mergeOperation, operationText } from '../src/taskOperations.ts';

const locations = [
  { id:'a', cwd:'/project', label:'A' },
  { id:'b', cwd:'/project', label:'B' },
  { id:'other', cwd:'/other', label:'Other' },
];
const defaults = {
  readClipboard: async () => '  请把这个想法做成原型。  ',
  readLocations: async () => ({ available:true, locations }),
  readPreference: () => ({ cwd:'/project', locationId:'b' }),
};

test('clipboard is requested inside the initiating click before network or other awaited work', async () => {
  const order=[];
  const promise=prepareQuickCreate({ ...defaults,
    readClipboard:()=>{order.push('clipboard');return Promise.resolve('hello');},
    readPreference:()=>{order.push('preference');return defaults.readPreference();},
    readLocations:async()=>{order.push('network');return defaults.readLocations();},
  });
  assert.deepEqual(order,['clipboard']);
  assert.deepEqual(await promise,{kind:'ready',input:{locationId:'b',initialQuery:'hello'}});
  assert.deepEqual(order,['clipboard','preference','network']);
});
test('quick creation uses the exact remembered directory and shared project with no synthetic name', async () => {
  assert.deepEqual(await prepareQuickCreate(defaults),{kind:'ready',input:{locationId:'b',initialQuery:'请把这个想法做成原型。'}});
});
test('missing or stale choices preserve clipboard text for deliberate selection, never pick a different project', async () => {
  for(const saved of [null,{cwd:'/project',locationId:''},{cwd:'/deleted',locationId:'b'},{cwd:'/other',locationId:'b'}]) {
    const result=await prepareQuickCreate({...defaults,readPreference:()=>saved});
    assert.equal(result.kind,'choose');assert.equal(result.text,'请把这个想法做成原型。');
  }
  const removed=await prepareQuickCreate({...defaults,readLocations:async()=>({available:true,locations:[locations[0]]})});
  assert.equal(removed.kind,'choose');
});
test('blocked clipboard access offers explicit paste without requesting creation options', async () => {
  const result=await prepareQuickCreate({...defaults,
    readClipboard:async()=>{throw new Error('NotAllowedError');},
    readLocations:async()=>{assert.fail('must not query options');},
  });
  assert.equal(result.kind,'paste');assert.equal(result.text,'');assert.match(result.hint,/粘贴/);
});
test('empty and oversized clipboard contents never reach creation options and are not silently truncated', async () => {
  for (const text of ['', ' \n ', '中'.repeat(16001)])
    await assert.rejects(prepareQuickCreate({...defaults,readClipboard:async()=>text,readLocations:async()=>{assert.fail('must not read options');}}));
  const accepted=await prepareQuickCreate({...defaults,readClipboard:async()=>'中'.repeat(16000)});
  assert.equal(accepted.input.initialQuery.length,16000);
});
test('created and first-message delivery are distinct; terminal creation only updates the matching message receipt', () => {
  const current={requestId:'create',operation:'create',status:'succeeded',creationStatus:'created',threadId:'task',initialMessage:{requestId:'first',status:'queued'}};
  assert.doesNotMatch(operationText(current),/已发送/);
  const accepted=mergeOperation(current,{...current,initialMessage:{requestId:'first',status:'accepted'}});
  assert.equal(accepted.status,'succeeded');assert.match(operationText(accepted),/已发送/);
  assert.equal(mergeOperation(current,{...current,initialMessage:{requestId:'different',status:'accepted'}}),current);
  const unknown={...current,status:'unknown',initialMessage:{requestId:'first',status:'not_queued'}};
  assert.match(operationText(unknown),/已创建/);assert.doesNotMatch(operationText(unknown),/已发送/);
});
