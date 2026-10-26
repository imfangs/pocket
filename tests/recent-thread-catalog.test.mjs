import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startRecentThreadCatalogSync } from '../src/recentThreadCatalog.ts';

function fixture(options={}) {
  const {startAt=100000, sync=async()=>{}}=options;
  const createdAt=Object.hasOwn(options,'createdAt')?options.createdAt:100000;
  let now=startAt, next=0, calls=0;
  const tasks=new Map(), browser=new EventTarget(), visibility=new EventTarget();
  Object.assign(browser,{navigator:{onLine:true},setTimeout(fn,delay){tasks.set(++next,{fn,at:now+delay});return next;},clearTimeout(id){tasks.delete(id);}});
  visibility.visibilityState='visible';
  const stop=startRecentThreadCatalogSync({createdAt,browser,visibility,now:()=>now,sync:()=>{calls++;return sync();}});
  async function advance(ms) {
    const until=now+ms;
    await setImmediate();
    while(true){
      const next=[...tasks].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      now=next[1].at;tasks.delete(next[0]);next[1].fn();await setImmediate();
    }
    now=until;
  }
  return {stop,advance,tasks,browser,visibility,calls:()=>calls,now:()=>now};
}

test('recent metadata uses at most eleven supplemental reads before its fixed creation deadline',async()=>{
  const f=fixture();
  await f.advance(4999);assert.equal(f.calls(),0);
  await f.advance(1);assert.equal(f.calls(),1);
  await f.advance(55000);assert.equal(f.calls(),11);assert.equal(f.tasks.size,0);
  await f.advance(120000);assert.equal(f.calls(),11);
  f.browser.dispatchEvent(new Event('pageshow'));await f.advance(5000);assert.equal(f.calls(),11);f.stop();
});

test('old, future and missing creation times never start supplemental polling',async()=>{
  for(const createdAt of [undefined,NaN,Infinity,0,-1,40000,100001]){
    const f=fixture({createdAt});
    f.browser.dispatchEvent(new Event('online'));
    await f.advance(120000);assert.equal(f.calls(),0);assert.equal(f.tasks.size,0);f.stop();
  }
});

test('entering a recent thread later uses only its remaining window',async()=>{
  const first=fixture();await first.advance(30000);first.stop();assert.equal(first.tasks.size,0);
  const reopened=fixture({startAt:145000});
  await reopened.advance(15000);assert.equal(reopened.calls(),2);assert.equal(reopened.tasks.size,0);
  reopened.stop();
});

test('hidden and offline pages pause until foreground without extending the deadline',async()=>{
  for(const mode of ['hidden','offline']){
    const f=fixture();
    await f.advance(5000);assert.equal(f.calls(),1);
    if(mode==='hidden'){f.visibility.visibilityState='hidden';f.visibility.dispatchEvent(new Event('visibilitychange'));}
    else{f.browser.navigator.onLine=false;f.browser.dispatchEvent(new Event('offline'));}
    assert.equal(f.tasks.size,0);await f.advance(20000);assert.equal(f.calls(),1);
    if(mode==='hidden'){f.visibility.visibilityState='visible';f.visibility.dispatchEvent(new Event('visibilitychange'));}
    else{f.browser.navigator.onLine=true;f.browser.dispatchEvent(new Event('online'));}
    await f.advance(4999);assert.equal(f.calls(),1);
    await f.advance(1);assert.equal(f.calls(),2);
    await f.advance(30000);assert.equal(f.calls(),7);assert.equal(f.tasks.size,0);f.stop();
  }
});

test('slow shared syncs never overlap, and completion after the deadline cannot restart polling',async()=>{
  let finish;
  const f=fixture({sync:()=>new Promise(resolve=>{finish=resolve;})});
  await f.advance(5000);assert.equal(f.calls(),1);
  f.browser.dispatchEvent(new Event('pageshow'));
  await f.advance(60000);assert.equal(f.calls(),1);
  finish();await f.advance(10000);assert.equal(f.calls(),1);assert.equal(f.tasks.size,0);f.stop();
});

test('failures retry only inside the creation window and stopping never cancels shared reads',async()=>{
  const failed=fixture({sync:async()=>{throw new Error('offline');}});
  await failed.advance(10000);assert.equal(failed.calls(),2);failed.stop();assert.equal(failed.tasks.size,0);
  let finish;
  const stopped=fixture({sync:()=>new Promise(resolve=>{finish=resolve;})});
  await stopped.advance(5000);stopped.stop();finish();await stopped.advance(60000);
  assert.equal(stopped.calls(),1);assert.equal(stopped.tasks.size,0);
});
