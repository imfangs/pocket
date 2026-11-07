import test from 'node:test';import assert from 'node:assert/strict';
import {storeNotificationTarget,readInitialNotificationTarget,clearNotificationTarget,notificationRouteUrl} from '../src/notificationTarget.ts';
const a='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',c='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const memory=()=>{const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
test('a notification retained before login opens its target rather than the existing old task URL',()=>{
 const storage=memory();storeNotificationTarget(storage,`?task=${a}&access_token=SHOULD_NOT_BE_STORED`,b,'ged');
 assert.ok(![...storage.values.values()].join('').includes('SHOULD_NOT_BE_STORED'));
 assert.equal(readInitialNotificationTarget(storage,`?task=${a}`,'ged'),b);assert.equal(readInitialNotificationTarget(storage,`?task=${a}`,'ged'),b);assert.equal(storage.values.size,2);clearNotificationTarget(storage,'ged');assert.equal(storage.values.size,0);
});
test('a newer explicit task URL takes priority over a pending notification from another route',()=>{
 const storage=memory();storeNotificationTarget(storage,`?task=${a}`,b,'ged');
 assert.equal(readInitialNotificationTarget(storage,`?task=${c}`,'ged'),c);assert.equal(storage.values.size,2);
});
test('notification pending target and marker stay in their machine namespace',()=>{
 const storage=memory();storeNotificationTarget(storage,`?task=${a}`,b,'ged');storeNotificationTarget(storage,'?machine=wandou',c,'wandou');
 assert.equal(readInitialNotificationTarget(storage,'?machine=wandou','wandou'),c);
 assert.equal(readInitialNotificationTarget(storage,`?task=${a}`,'ged'),b);assert.equal(storage.values.size,4);clearNotificationTarget(storage,'ged');assert.equal(storage.values.size,2);
});
test('legacy markers, malformed or oversized entries and blocked storage do not invalidate an explicit deep link',()=>{
 for(const marker of ['{broken','x'.repeat(161),JSON.stringify({version:1,target:b,routeTask:a,secret:'extra'})]){
  const storage=memory();storage.setItem('pocket.pending-task',b);storage.setItem('pocket.pending-task-entry',marker);
  assert.equal(readInitialNotificationTarget(storage,`?task=${a}`,'ged'),a);
 }
 const storage=memory();storage.setItem('pocket.pending-task',b);assert.equal(readInitialNotificationTarget(storage,'','ged'),b);
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
 assert.equal(readInitialNotificationTarget(blocked,`?task=${c}`,'ged'),c);assert.throws(()=>storeNotificationTarget(memory(),'','not-a-task','ged'));
});
test('clearing an obsolete target removes both records without another machine being changed',()=>{
 const storage=memory();storeNotificationTarget(storage,'',a,'ged');storeNotificationTarget(storage,'',b,'wandou');clearNotificationTarget(storage,'ged');
 assert.equal(readInitialNotificationTarget(storage,'','ged'),null);assert.equal(readInitialNotificationTarget(storage,'','wandou'),b);
});

test("notification navigation pins only the accepted task and machine, without retaining unrelated URL data",()=>{
 const url=new URL(notificationRouteUrl(`https://example.test/?task=${a}&auth=DROP#secret`,"ged",b));
 assert.equal(url.search,`?machine=ged&task=${b}`);assert.equal(url.hash,"");
 assert.equal(new URL(notificationRouteUrl(url.href,"ged",c)).search,`?machine=ged&task=${c}`);
 assert.equal(new URL(notificationRouteUrl(url.href,"ged",null)).search,"?machine=ged");
});
