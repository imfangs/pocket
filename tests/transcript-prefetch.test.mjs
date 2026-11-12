import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTranscriptReader } from '../src/transcriptReader.ts';

const id=n=>`bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12,'0')}`;
const candidate=(n,revision=1,scope='scope')=>({id:id(n),content:{known:true,scope,revision,version:String(revision%10).repeat(64),messageId:`message-${n}-${revision}`}});
const response=(item,text='Synthetic body')=>({source:'rollout',checkedAt:1000000,messages:[{id:item.content.messageId,role:'assistant',text}],pocketContent:{...item.content}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();await setImmediate();};

function fixture(overrides={}) {
  let now=1000000,sequence=0,identity=true,canRun=true;
  const timers=new Map(),requests=[],loads=[],writes=[];
  const reader=createTranscriptReader({machine:'ged',scope:'scope',now:()=>now,gapMs:10,timeoutMs:100,
    current:()=>identity,canPrefetch:()=>canRun,
    getForegroundId:overrides.getForegroundId,
    setTimeout:(callback,delay)=>{const key=++sequence;timers.set(key,{at:now+delay,callback});return key;},clearTimeout:key=>timers.delete(key),
    request:(threadId,signal)=>{const d=deferred();requests.push({threadId,signal,at:now,...d});return d.promise;},
    cache:{loadTranscript:async(machine,scope,threadId)=>{loads.push({machine,scope,threadId});return overrides.load?.(threadId)??null;},
      rememberTranscript:(machine,scope,threadId,data)=>{writes.push({machine,scope,threadId,data});return overrides.remember?.(data)??true;}},
  });
  const advance=async ms=>{
    const end=now+ms;await flush();let steps=0;
    while(true){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      assert.ok(++steps<1000,'timer loop remains bounded');timers.delete(next[0]);now=next[1].at;next[1].callback();await flush();}
    now=end;await flush();
  };
  return{reader,requests,loads,writes,timers,advance,identity:value=>{identity=value;},canRun:value=>{canRun=value;},
    update:(items,state={})=>reader.update(items,{enabled:true,foregroundId:null,...state})};
}

test('the fixed eight-item window checks matching cached versions once without draining the catalog',async()=>{
  const all=Array.from({length:64},(_,i)=>candidate(i));
  const f=fixture({load:threadId=>({scope:'scope',value:response(all.find(x=>x.id===threadId)),savedAt:1000000})});
  f.update(all);await f.advance(200);
  assert.equal(f.loads.length,8);assert.equal(f.requests.length,0);
  f.update(structuredClone(all));await f.advance(120000);
  assert.equal(f.loads.length,8);assert.equal(f.requests.length,0);
  f.reader.stop();assert.equal(f.timers.size,0);
});

test('background reads fill independent lanes, then persist only the matching source content',async()=>{
  const a=candidate(1),b=candidate(2),f=fixture();f.update([a,b]);await f.advance(10);
  assert.equal(f.requests.length,2);await f.advance(30);assert.equal(f.requests.length,2);
  f.requests[0].resolve(response(a));await f.advance(10);
  assert.equal(f.writes.length,1);assert.equal(f.requests.length,2);
  f.requests[1].resolve(response(b));await f.advance(500);
  assert.equal(f.writes.length,2);assert.equal(f.requests.length,2);
  f.reader.stop();
});

test('foreground takes over the same in-flight read and background cancellation cannot kill it',async()=>{
  const a=candidate(1),f=fixture();f.update([a]);await f.advance(10);
  const foreground=new AbortController();const pending=f.reader.read(a.id,foreground.signal);
  f.update([],{enabled:false,foregroundId:a.id});f.reader.wake(true);await flush();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].signal.aborted,false);
  f.requests[0].resolve(response(a));assert.deepEqual(await pending,response(a));
  assert.equal(f.writes.length,0,'a no-longer-selected background version is not written');f.reader.stop();
});

test('a background deadline does not abort an attached foreground consumer',async()=>{
  const a=candidate(1),f=fixture();f.update([a]);await f.advance(10);
  const controller=new AbortController(),pending=f.reader.read(a.id,controller.signal);
  await f.advance(100);assert.equal(f.requests[0].signal.aborted,false);
  f.requests[0].resolve(response(a));assert.deepEqual(await pending,response(a));
  assert.equal(f.writes.length,0);f.reader.stop();
});

test('new selection protects its transport before parent layout updates the scheduler',async()=>{
  let selected=null;const a=candidate(1),f=fixture({getForegroundId:()=>selected});
  f.update([a]);await f.advance(10);
  selected=a.id;f.canRun(false);f.reader.wake();
  assert.equal(f.requests[0].signal.aborted,false,'a detail focus event must not cancel its pending read');
  const pending=f.reader.read(a.id,new AbortController().signal);f.update([],{foregroundId:a.id});
  assert.equal(f.requests.length,1);f.requests[0].resolve(response(a));assert.deepEqual(await pending,response(a));f.reader.stop();
});

test('each foreground signal cancels only its own consumer; the last one aborts the transport',async()=>{
  const f=fixture(),a=candidate(1),first=new AbortController(),second=new AbortController();
  const p1=f.reader.read(a.id,first.signal),p2=f.reader.read(a.id,second.signal);await flush();
  const failed1=assert.rejects(p1,{name:'AbortError'});first.abort();await failed1;
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].signal.aborted,false);
  const failed2=assert.rejects(p2,{name:'AbortError'});second.abort();await failed2;
  assert.equal(f.requests[0].signal.aborted,true);f.reader.stop();f.requests[0].resolve(response(a));await flush();
});

test('foreground work on another thread preempts background work and pauses the next slot',async()=>{
  const a=candidate(1),b=candidate(2),f=fixture();f.update([a,b]);await f.advance(10);
  const c=new AbortController(),pending=f.reader.read(id(99),c.signal);await flush();
  assert.ok(f.requests.slice(0,2).every(item=>item.signal.aborted));assert.equal(f.requests[2].threadId,id(99));
  await f.advance(500);assert.equal(f.requests.length,3);
  f.requests[2].resolve(response(candidate(99)));await pending;await f.advance(10);
  assert.equal(f.requests.length,3,'foreground completion does not bypass the queue cooldown');
  await f.advance(2000);
  assert.deepEqual(f.requests.slice(3,5).map(item=>item.threadId),[a.id,b.id]);f.reader.stop();
});

test('failed high-rank work backs off without starving untried candidates',async()=>{
  const items=[candidate(1),candidate(2),candidate(3)],f=fixture();f.update(items);await f.advance(10);
  f.requests[0].reject(new Error('network'));await f.advance(10);
  f.requests[1].reject(new Error('network'));await f.advance(10);
  assert.deepEqual(f.requests.map(x=>x.threadId),items.map(x=>x.id));
  f.requests[2].resolve(response(items[2]));await f.advance(20);
  f.update(structuredClone(items));await f.advance(1000);
  assert.equal(f.requests.length,3,'repeated catalog objects do not reset backoff');f.reader.stop();
});

test('a newly selected version cancels the old background consumer and rejects its late body',async()=>{
  const a=candidate(1),next=candidate(1,2),f=fixture();f.update([a]);await f.advance(10);
  f.update([next]);await f.advance(10);assert.equal(f.requests[0].signal.aborted,true);
  f.requests[0].resolve(response(a));await flush();assert.equal(f.writes.length,0);
  f.requests[1].resolve(response(next));await f.advance(10);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].data.pocketContent.revision,2);f.reader.stop();
});

test('foreign, regressed and conflicting content never enters the reading cache or retries an unchanged catalog',async()=>{
  for(const data of [response(candidate(1,1,'foreign'),'Foreign body'),response(candidate(1,1),'Older body'),
    response({...candidate(1,2),content:{...candidate(1,2).content,version:'f'.repeat(64)}},'Conflicting body'),
    {...response(candidate(1)),pocketContent:null}]){
    const a=candidate(1,2),f=fixture();f.update([a]);await f.advance(10);f.requests[0].resolve(data);await f.advance(120000);
    assert.equal(f.writes.length,0);assert.equal(f.requests.length,1);f.reader.stop();
  }
});

test('valid newer same-scope content warms the cache once while the catalog catches up',async()=>{
  const a=candidate(1),newer=candidate(1,2),f=fixture();f.update([a]);await f.advance(10);
  f.requests[0].resolve(response(newer));await f.advance(120000);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].data.pocketContent.revision,2);assert.equal(f.requests.length,1);
  f.update([structuredClone(a)]);await f.advance(120000);assert.equal(f.requests.length,1);f.reader.stop();
});

test('cache rejection never leads to repeated same-version downloads',async()=>{
  const a=candidate(1),f=fixture({remember:()=>false});f.update([a]);await f.advance(10);
  f.requests[0].resolve(response(a));await f.advance(10000);f.update([structuredClone(a)]);await f.advance(10000);
  assert.equal(f.requests.length,1);assert.equal(f.writes.length,1);f.reader.stop();
});

test('a cancelled cache probe releases the scheduler even if IndexedDB resolves much later',async()=>{
  const a=candidate(1),b=candidate(2),wait=deferred(),f=fixture({load:threadId=>threadId===a.id?wait.promise:null});
  f.update([a]);await f.advance(10);assert.equal(f.requests.length,0);
  f.update([b]);await f.advance(10);assert.equal(f.requests.length,1);assert.equal(f.requests[0].threadId,b.id);
  wait.resolve({scope:'scope',value:response(a),savedAt:1000000});await flush();assert.equal(f.writes.length,0);f.reader.stop();
});

test('visibility/editing gates pause work, while a later wake resumes only unfinished candidates',async()=>{
  const a=candidate(1),f=fixture();f.canRun(false);f.update([a]);await f.advance(1000);assert.equal(f.requests.length,0);
  f.canRun(true);f.reader.wake();await f.advance(10);assert.equal(f.requests.length,1);
  f.canRun(false);f.reader.wake(true);await flush();assert.equal(f.requests[0].signal.aborted,true);
  await f.advance(5000);assert.equal(f.requests.length,1);
  f.canRun(true);f.reader.wake();await f.advance(10);assert.equal(f.requests.length,2);f.reader.stop();
});

test('scope/machine invalidation and stop reject late results before cache writes or delivery',async()=>{
  for(const stop of [false,true]){
    const a=candidate(1),f=fixture();f.update([a]);await f.advance(10);
    const c=new AbortController(),pending=f.reader.read(a.id,c.signal);const rejected=assert.rejects(pending,{name:'AbortError'});
    if(stop)f.reader.stop();else f.identity(false);
    f.requests[0].resolve(response(a));await rejected;await flush();assert.equal(f.writes.length,0);f.reader.stop();
  }
});

test('a stop between transport settlement and consumer delivery still rejects the foreground result',async()=>{
  let reader;const a=candidate(1);
  const later=n=>queueMicrotask(()=>n?later(n-1):reader.stop());
  reader=createTranscriptReader({machine:'ged',scope:'scope',current:()=>true,
    cache:{loadTranscript:async()=>null,rememberTranscript:()=>true},
    request:()=>{const value=Promise.resolve(response(a));later(5);return value;}});
  await assert.rejects(reader.read(a.id,new AbortController().signal),{name:'AbortError'});reader.stop();
});

test('older foreground payloads stay readable without content metadata and never use a cache hit as network data',async()=>{
  const a=candidate(1),f=fixture({load:()=>({scope:'scope',value:response(a,'Cached'),savedAt:1000000})});
  const pending=f.reader.read(a.id,new AbortController().signal);await flush();
  assert.equal(f.loads.length,0);assert.equal(f.requests.length,1);
  const legacy={source:'rollout',messages:[{id:'legacy',role:'assistant',text:'Actual network result'}],checkedAt:1000000};
  f.requests[0].resolve(legacy);assert.deepEqual(await pending,legacy);assert.equal(f.writes.length,0);f.reader.stop();
});

test('running same-version content keeps validating every five seconds and pauses while hidden', async () => {
  const item = { ...candidate(1), refresh: 'running' }, f = fixture();
  f.update([item]); await f.advance(10);
  for (let i = 0; i < 4; i++) {
    assert.equal(f.requests.length, i + 1);
    f.requests[i].resolve(response(item, `New process ${i}`)); await f.advance(10);
    assert.equal(f.writes.at(-1).data.messages[0].text, `New process ${i}`);
    if (i < 3) { await f.advance(5000); assert.ok(f.requests[i + 1].at - f.requests[i].at >= 5000); }
  }
  assert.equal(f.loads.length, 1, 'repeat network validation does not repeatedly scan disk');
  f.canRun(false); f.reader.wake(true); await f.advance(30000); assert.equal(f.requests.length, 4);
  f.canRun(true); f.reader.wake(); await f.advance(10); assert.equal(f.requests.length, 5);
  f.reader.stop();
});

test('an unread cache hit still receives a real read and then validates at the slower thirty-second cadence', async () => {
  const item = { ...candidate(1), refresh: 'unread' };
  const f = fixture({ load: () => ({ scope: 'scope', value: response(item, 'Previously cached'), savedAt: 1000000 }) });
  f.update([item]); await f.advance(10); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(response(item, 'Actual current query and body')); await f.advance(10);
  assert.equal(f.writes[0].data.messages[0].text, 'Actual current query and body');
  await f.advance(29000); assert.equal(f.requests.length, 1);
  f.update([{ ...item }]); await f.advance(1000); assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].at - f.requests[0].at >= 30000);
  f.reader.stop();
});

test('eight repeated candidates use eight lanes and unread work precedes another active refresh', async () => {
  const items = Array.from({ length: 8 }, (_, n) => ({ ...candidate(n + 1), refresh: n === 7 ? 'unread' : 'running' }));
  const f = fixture(); f.update(items); await f.advance(10);
  assert.equal(f.requests.length, 8, 'eight background reads fill the bounded lanes');
  for (let n = 0; n < 8; n++) {
    assert.equal(f.requests[n].threadId, items[n].id);
    f.requests[n].resolve(response(items[n]));
  }
  await f.advance(10);
  assert.equal(f.writes.length, 8); assert.deepEqual(f.requests.map(item => item.threadId), items.map(item => item.id));
  await f.advance(5000); assert.equal(f.requests[8].threadId, items[0].id);
  f.reader.stop();
});

test('unknown-version running reads warm only a known same-scope response and retain the eight-item bound', async () => {
  const received = candidate(1), item = { id: received.id, content: null, refresh: 'running' }, f = fixture();
  f.update([item]); await f.advance(10); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(response(received)); await f.advance(10); assert.equal(f.writes.length, 1);
  await f.advance(5000); assert.equal(f.requests.length, 2); f.reader.stop();
  for (const value of [{ ...response(received), pocketContent: null }, response(candidate(1, 1, 'foreign'))]) {
    const blocked = fixture(); blocked.update([item]); await blocked.advance(10); blocked.requests[0].resolve(value); await blocked.advance(120000);
    assert.equal(blocked.writes.length, 0); assert.equal(blocked.requests.length, 1); blocked.reader.stop();
  }
});

test('a new content identity validates immediately and a completed/read mode stops active polling', async () => {
  const running = { ...candidate(1), refresh: 'running' }, unread = { ...candidate(1, 2), refresh: 'unread' }, f = fixture();
  f.update([running]); await f.advance(10); f.requests[0].resolve(response(running)); await f.advance(10);
  f.update([unread]); await f.advance(10); assert.equal(f.requests.length, 2, 'new final/version is not delayed by the old running timer');
  f.requests[1].resolve(response(unread)); await f.advance(10);
  f.update([candidate(1, 2)]); await f.advance(10); assert.equal(f.requests.length, 3, 'completion/read receives one final full-body validation');
  f.requests[2].resolve(response(candidate(1, 2))); await f.advance(120000); assert.equal(f.requests.length, 3, 'a read, idle chat then reverts to one-shot behavior');
  f.reader.stop();
});

test('a running-to-idle transition validates same-version terminal metadata once without manufacturing a new content version', async () => {
  const running = { ...candidate(1), refresh: 'running' }, f = fixture(); f.update([running]); await f.advance(10);
  f.requests[0].resolve(response(running)); await f.advance(10);
  f.update([candidate(1)]); await f.advance(10); assert.equal(f.requests.length, 2);
  const terminal = { ...response(candidate(1)), turnFailures: [{ turnId: 'actual-failed-turn', message: 'Synthetic terminal error' }] };
  f.requests[1].resolve(terminal); await f.advance(120000);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.writes.at(-1).data.turnFailures, terminal.turnFailures);
  assert.equal(f.writes.at(-1).data.pocketContent.version, running.content.version);
  f.reader.stop();
});

test('a runtime-mode update does not reset an existing network backoff or accept a regressed active body', async () => {
  const item = { ...candidate(1), refresh: 'running' }, f = fixture(); f.update([item]); await f.advance(10);
  f.requests[0].reject(new Error('network')); await f.advance(10);
  f.update([{ ...item, refresh: 'unread' }]); await f.advance(1000); assert.equal(f.requests.length, 1);
  await f.advance(1000); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(response(candidate(1, 2))); await f.advance(10); await f.advance(30000);
  assert.equal(f.requests.length, 3); f.requests[2].resolve(response(candidate(1, 1))); await f.advance(120000);
  assert.equal(f.writes.length, 1, 'a newer validated version cannot be overwritten by the old catalog version');
  assert.equal(f.requests.length, 3, 'same-key regression waits for new directory identity'); f.reader.stop();
});

test('a periodic background deadline never cancels the attached foreground reader or substitutes an older cached body', async () => {
  for (const refresh of ['running', 'unread']) {
    const item = { ...candidate(1), refresh }, f = fixture({ load: () => ({ scope: 'scope', value: response(item, 'Older cached display'), savedAt: 1000000 }) });
    f.update([item]); await f.advance(10); const controller = new AbortController();
    const reading = f.reader.read(item.id, controller.signal); await f.advance(100);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].signal.aborted, false);
    f.requests[0].resolve(response(item, 'Actual live read'));
    assert.equal((await reading).messages[0].text, 'Actual live read');
    assert.equal(f.writes.length, 0, 'an expired speculative consumer cannot publish as the current observer');
    f.reader.stop();
  }
});

test('catalog catch-up cannot lower a validated body floor when the cache was evicted', async () => {
  const first = { ...candidate(1, 1), refresh: 'running' }, catchup = { ...candidate(1, 2), refresh: 'running' }, newer = candidate(1, 3), f = fixture();
  f.update([first]); await f.advance(10); f.requests[0].resolve(response(newer)); await f.advance(10);
  assert.equal(f.writes[0].data.pocketContent.revision, 3);
  f.update([catchup]); await f.advance(10); f.requests[1].resolve(response(catchup)); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.revision), [3], 'an older catalog identity cannot authorize writing an older full body');
  const latest = { ...candidate(1, 4), refresh: 'running' };
  f.update([latest]); await f.advance(10); f.requests[2].resolve(response(latest)); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.revision), [3, 4]);
  f.reader.stop();
});

test('a stale cache hit cannot replace the same-owner version floor across a candidate key change', async () => {
  let cached = null;
  const first = { ...candidate(1, 1), refresh: 'running' }, catchup = { ...candidate(1, 2), refresh: 'running' }, f = fixture({ load: () => cached });
  f.update([first]); await f.advance(10); f.requests[0].resolve(response(candidate(1, 3))); await f.advance(10);
  cached = { scope: 'scope', value: response(catchup), savedAt: 1000000 };
  f.update([catchup]); await f.advance(10); f.requests[1].resolve(response(catchup)); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.revision), [3]);
  f.reader.stop();
});

test('the required floor includes both the validated response and the higher current catalog identity', async () => {
  const first = { ...candidate(1, 1), refresh: 'running' }, current = { ...candidate(1, 4), refresh: 'running' }, f = fixture();
  f.update([first]); await f.advance(10); f.requests[0].resolve(response(candidate(1, 3))); await f.advance(10);
  f.update([current]); await f.advance(10); f.requests[1].resolve(response(candidate(1, 3))); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.revision), [3], 'preserving the old floor cannot hide a newer catalog requirement');
  f.reader.stop();
});

test('a same-revision catalog conflict cannot replace a validated version, but a genuinely higher version can', async () => {
  const first = { ...candidate(1, 1), refresh: 'running' }, known = candidate(1, 3), f = fixture();
  f.update([first]); await f.advance(10); f.requests[0].resolve(response(known)); await f.advance(10);
  const conflict = { ...candidate(1, 3), content: { ...known.content, version: 'f'.repeat(64) }, refresh: 'running' };
  f.update([conflict]); await f.advance(10); f.requests[1].resolve(response(conflict)); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.version), [known.content.version]);
  const newer = { ...candidate(1, 4), refresh: 'running' };
  f.update([newer]); await f.advance(10); f.requests[2].resolve(response(newer)); await f.advance(10);
  assert.deepEqual(f.writes.map(item => item.data.pocketContent.revision), [3, 4]); f.reader.stop();
});

function pollingFixture(mode,count) {
  let now=1000000,sequence=0,polling=true,externalBusy=false,selected=id(99);
  const timers=new Map(),requests=[],writes=[];
  const later=(callback,delay)=>{const key=++sequence;timers.set(key,{at:now+delay,callback});return key;};
  const clear=key=>timers.delete(key),items=Array.from({length:count},(_,n)=>candidate(n+1));
  const reader=createTranscriptReader({machine:'ged',scope:'scope',now:()=>now,current:()=>true,
    getForegroundId:()=>selected,canPrefetch:()=>!externalBusy,setTimeout:later,clearTimeout:clear,
    cache:{loadTranscript:async()=>null,rememberTranscript:(_machine,_scope,threadId)=>{writes.push({threadId,at:now});return true;}},
    request:(threadId,signal)=>new Promise((resolve,reject)=>{
      const background=threadId!==id(99),entry={threadId,background,at:now,aborted:false,completedAt:null};requests.push(entry);
      const timer=later(()=>{entry.completedAt=now;resolve(response(background?items.find(x=>x.id===threadId):candidate(99)));},background?1500:50);
      signal.addEventListener('abort',()=>{entry.aborted=true;clear(timer);reject(new DOMException('cancelled','AbortError'));},{once:true});
    }),
  });
  const poll=()=>{
    if(!polling)return;
    if(mode==='request-activity'){
      externalBusy=true;reader.wake();
      later(()=>{externalBusy=false;reader.wake();if(polling)later(poll,2000);},50);
    }else reader.read(id(99),new AbortController().signal).then(()=>{if(polling)later(poll,2000);},()=>{});
  };
  reader.update(items,{enabled:true,foregroundId:selected});poll();
  const advance=async ms=>{
    const end=now+ms;await flush();let steps=0;
    while(true){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;
      assert.ok(++steps<5000);timers.delete(next[0]);now=next[1].at;next[1].callback();await flush();}
    now=end;await flush();
  };
  return{reader,requests,writes,advance,now:()=>now,stopPolling:()=>{polling=false;},
    returnToList:()=>{selected=null;reader.update(items,{enabled:true,foregroundId:null});}};
}

for(const mode of ['shared-reader','request-activity'])for(const count of [1,8])
  test(`repeated ${mode} preemption cools the whole ${count}-candidate queue and recovers`,async t=>{
    const f=pollingFixture(mode,count);await f.advance(60000);
    const interrupted=f.requests.filter(x=>x.background);
    const batches=new Set(interrupted.map(item=>item.at));
    assert.ok(interrupted.length>0&&batches.size<=6,'sixty seconds of foreground polls must not create 29 wasted batches');
    assert.ok(interrupted.length<=6*Math.min(8,count),'each interrupted batch has at most eight transfers');
    assert.ok(interrupted.every(x=>x.aborted));assert.equal(f.writes.length,0);
    if(mode==='shared-reader'){
      const foreground=f.requests.filter(x=>!x.background);
      assert.equal(foreground.length,30,'foreground cadence is unchanged by background cooldown');
      assert.ok(foreground.every(x=>x.completedAt-x.at===50),'foreground requests are never queued behind cooldown');
    }
    t.diagnostic(JSON.stringify({mode,candidates:count,seconds:60,backgroundBatches:batches.size,backgroundStarts:interrupted.length,backgroundAborts:interrupted.filter(x=>x.aborted).length}));
    f.stopPolling();const stoppedAt=f.now();
    if(count===1){
      f.returnToList();await f.advance(3000);
      const restored=f.requests.filter(x=>x.background)[interrupted.length];
      assert.ok(restored.at-stoppedAt<=1000,'returning to the list promptly releases the old foreground cooldown');
      assert.equal(f.writes.length,1);
    }else{
      await f.advance(35000);
      const restored=f.requests.filter(x=>x.background).slice(interrupted.length);
      assert.ok(f.writes.length>1,'a quiet detail resumes useful prefetch within the bounded cooldown');
      assert.ok(restored[0].at-stoppedAt<=30000);
      assert.equal(restored.length,8,'the recovered fixed window needs only one batch');
      assert.ok(restored.every(item=>item.at===restored[0].at&&item.completedAt-item.at===1500));
    }
    f.reader.stop();
  });
