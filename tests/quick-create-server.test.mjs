import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';
import { LifecycleService } from '../server/lifecycle.mjs';

const created='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const requestId='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const query='Continue this synthetic task exactly once.';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pocket-quick-create-'));
  const state={creates:0,sends:[],opens:0,hasThread:false,active:false,extraThreads:[]};
  let store,desktop,lifecycle;
  const source=()=>({threads:[...state.extraThreads,...(state.hasThread?[{id:created,title:'Synthetic new task',cwd:directory,archived:false}]:[])],projects:[],sourceInfo:{}});
  const create=async payload=>{
    state.creates++;state.hasThread=true;
    writeFileSync(payload.receiptPath,JSON.stringify({requestId:payload.requestId,threadId:created}));
    return {status:'created',threadId:created,verified:true,processStopped:true};
  };
  const initialize=()=>{
    store=new NavigatorStore(directory);store.sync(source());
    desktop=new DesktopService(store,directory,async payload=>{
      if(payload.operation==='history')return {ok:true,source:'desktop',resumeState:'resumed',runtime:state.active?'active':'idle',canSend:!state.active,queueReady:!state.active,messages:[]};
      state.sends.push(payload);state.active=true;
      return {ok:true,turnId:'synthetic-turn'};
    },()=>({source:'rollout',runtime:'unavailable',canSend:false,messages:[]}),{openThread:async()=>{state.opens++;}});
    lifecycle=new LifecycleService(store,desktop,directory,()=>store.sync(source()),{
      locations:()=>[{id:'location',label:'Fixture',cwd:directory}],create,tickMs:100000,
    });
  };
  const stop=()=>{lifecycle.stop();desktop.stopQueue();store.close();};
  initialize();
  t.after(()=>{stop();rmSync(directory,{recursive:true,force:true});});
  return {
    state,directory,
    get store(){return store;},get desktop(){return desktop;},get lifecycle(){return lifecycle;},
    restart(){stop();initialize();},
    async start(initialQuery=query){
      const receipt=lifecycle.startCreate({requestId,locationId:'location',initialQuery});
      await lifecycle.running.get(requestId);
      return {receipt,settled:lifecycle.receipt(lifecycle.row(requestId))};
    },
  };
}

test('quick create completes only after durable enqueue, with separate creation and submission identities',async t=>{
  const f=fixture(t);
  const {receipt,settled}=await f.start();
  assert.equal(receipt.status,'pending');assert.equal(receipt.initialMessage.status,'not_queued');
  assert.equal(settled.status,'succeeded');assert.equal(settled.creationStatus,'created');
  assert.equal(settled.initialMessage.status,'queued');assert.notEqual(settled.initialMessage.requestId,requestId);
  assert.match(settled.initialMessage.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(f.state.creates,1);assert.equal(f.state.sends.length,0,'creation is not a model execution');
  assert.deepEqual(f.desktop.outbox(created).map(item=>[item.id,item.text]),[[settled.initialMessage.requestId,query]]);
  assert.equal(f.lifecycle.blocked.has(created),false,'verified creation must not block its original owner queue');
  assert.equal(JSON.parse(f.lifecycle.row(requestId).payload).initialQuery,query);
  assert.equal(JSON.stringify(f.lifecycle.list()).includes(query),false,'operation receipts do not expose the saved clipboard text');
  await f.desktop.processQueueForThread(created);
  const accepted=await f.lifecycle.get(requestId);
  assert.equal(accepted.status,'succeeded');assert.equal(accepted.initialMessage.status,'accepted');
  assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0].requestId,settled.initialMessage.requestId);
});

test('identical retries reuse one native task and first message, while changing the query is rejected',async t=>{
  const f=fixture(t);const {settled}=await f.start();
  f.lifecycle.locations=()=>[];
  for(let n=0;n<3;n++){
    const retry=f.lifecycle.startCreate({requestId,locationId:'location',initialQuery:query});
    assert.equal(retry.initialMessage.requestId,settled.initialMessage.requestId);
    await f.lifecycle.get(requestId);
  }
  assert.equal(f.state.creates,1);assert.equal(f.desktop.outbox(created).length,1);
  assert.throws(()=>f.lifecycle.startCreate({requestId,locationId:'location',initialQuery:'Different query'}),error=>error.status===409);
  assert.throws(()=>f.lifecycle.startCreate({requestId,locationId:'location'}),error=>error.status===409);
  await f.desktop.processQueueForThread(created);
  f.restart();await f.lifecycle.get(requestId);
  f.lifecycle.startCreate({requestId,locationId:'location',initialQuery:query});
  await f.desktop.processQueueForThread(created);
  assert.equal(f.state.creates,1);assert.equal(f.state.sends.length,1);assert.equal(f.desktop.outbox(created).length,0);
});

test('concurrent retries join the reserved creation instead of scheduling another creator or first message',async t=>{
  const f=fixture(t),create=f.lifecycle.create;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.lifecycle.create=async payload=>{await gate;return create(payload);};
  const input={requestId,locationId:'location',initialQuery:query};
  const first=f.lifecycle.startCreate(input);
  for(let n=0;n<3;n++){
    const retry=f.lifecycle.startCreate(input);
    assert.equal(retry.status,'pending');assert.equal(retry.initialMessage.requestId,first.initialMessage.requestId);
  }
  release();await f.lifecycle.running.get(requestId);
  assert.equal(f.state.creates,1);assert.equal(f.desktop.outbox(created).length,1);
});

test('invalid clipboard queries are rejected before reserving or creating a native task',async t=>{
  const f=fixture(t);
  for(const initialQuery of ['', ' \n ', null, 4, {}, 'x'.repeat(16001)])
    assert.throws(()=>f.lifecycle.startCreate({requestId,locationId:'location',initialQuery}),error=>error.status===400);
  assert.equal(f.state.creates,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM lifecycle_operations').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n,0);
});

test('unverified creation never enqueues or reconnects, and missing checkpoints never create a second task',async t=>{
  const f=fixture(t);
  f.lifecycle.create=async()=>{f.state.creates++;return {status:'unknown',threadId:created,code:'create_unconfirmed'};};
  const {settled}=await f.start();
  assert.equal(settled.status,'unknown');assert.equal(settled.creationStatus,undefined);
  assert.equal(settled.initialMessage.status,'not_queued');assert.equal(f.lifecycle.blocked.has(created),true);
  for(let n=0;n<3;n++){await f.lifecycle.get(requestId);await f.lifecycle.tick();}
  f.lifecycle.startCreate({requestId,locationId:'location',initialQuery:query});
  assert.equal(f.state.creates,1);assert.equal(f.state.opens,0);assert.equal(f.state.sends.length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM outgoing_messages').get().n,0);
});

test('a creator checkpoint can finish the original creation and enqueue the query once',async t=>{
  const f=fixture(t),create=f.lifecycle.create;
  f.lifecycle.create=async payload=>{
    const result=await create(payload);
    return {...result,status:'unknown',verified:false};
  };
  const {settled}=await f.start();assert.equal(settled.status,'unknown');
  f.lifecycle.create=async()=>({status:'created',threadId:created,verified:true,processStopped:true});
  const recovered=await f.lifecycle.get(requestId);
  assert.equal(recovered.status,'succeeded');assert.equal(recovered.initialMessage.status,'queued');
  assert.equal(f.state.creates,1);assert.equal(f.desktop.outbox(created).length,1);
});

test('restart after native verification continues from the saved phase without invoking the creator',async t=>{
  const f=fixture(t);
  f.desktop.send=async()=>{f.lifecycle.stop();throw new Error('Simulated process exit before queue write');};
  const {settled}=await f.start();
  assert.equal(settled.status,'pending');assert.equal(settled.creationStatus,'created');
  assert.equal(settled.initialMessage.status,'not_queued');
  f.restart();await f.lifecycle.tick();
  const recovered=await f.lifecycle.get(requestId);
  assert.equal(recovered.status,'succeeded');assert.equal(recovered.initialMessage.status,'queued');
  assert.equal(f.state.creates,1);assert.equal(f.desktop.outbox(created).length,1);
});

test('restart after durable enqueue claims the existing message even if it was accepted before lifecycle recovery',async t=>{
  const f=fixture(t),send=f.desktop.send.bind(f.desktop);
  f.desktop.send=async(...args)=>{const receipt=await send(...args);f.lifecycle.stop();return receipt;};
  const {settled}=await f.start();assert.equal(settled.status,'pending');assert.equal(settled.initialMessage.status,'queued');
  const firstId=settled.initialMessage.requestId;
  f.restart();await f.desktop.processQueueForThread(created);
  assert.equal(f.state.sends.length,1);assert.equal(f.desktop.outbox(created).length,0);
  const recovered=await f.lifecycle.get(requestId);
  assert.equal(recovered.status,'succeeded');assert.equal(recovered.initialMessage.status,'accepted');
  assert.equal(recovered.initialMessage.requestId,firstId);assert.equal(f.state.creates,1);
  await f.lifecycle.tick();await f.desktop.processQueueForThread(created);
  assert.equal(f.state.sends.length,1);
});

test('recovery preserves a user edit or removal of the first queued message',async t=>{
  for(const action of ['edit','cancel']){
    await t.test(action,async t=>{
      const f=fixture(t),send=f.desktop.send.bind(f.desktop);
      f.desktop.send=async(...args)=>{const receipt=await send(...args);f.lifecycle.stop();return receipt;};
      const {settled}=await f.start(),messageId=settled.initialMessage.requestId;
      if(action==='edit'){
        f.desktop.pauseQueued(created,messageId,{expectedRevision:0});
        f.desktop.editQueued(created,messageId,{expectedRevision:1,text:'User replacement'});
      }else f.desktop.cancelQueued(created,messageId,{expectedRevision:0});
      f.restart();const recovered=await f.lifecycle.get(requestId);
      assert.equal(recovered.status,'succeeded');assert.equal(f.state.creates,1);
      if(action==='edit')assert.deepEqual(f.desktop.outbox(created).map(item=>item.text),['User replacement']);
      else {assert.equal(recovered.initialMessage.status,'cancelled');assert.equal(f.desktop.outbox(created).length,0);}
    });
  }
});

test('a definite enqueue failure leaves the verified task and query available for safe recovery',async t=>{
  const f=fixture(t),send=f.desktop.send.bind(f.desktop);
  f.desktop.send=async()=>{throw new Error('Synthetic queue unavailable');};
  const {settled}=await f.start();
  assert.equal(settled.status,'unknown');assert.equal(settled.creationStatus,'created');
  assert.equal(settled.code,'initial_message_not_queued');assert.equal(settled.initialMessage.status,'not_queued');
  assert.equal(f.store.thread(created).id,created);assert.equal(f.lifecycle.blocked.has(created),false);
  f.desktop.send=send;const recovered=await f.lifecycle.get(requestId);
  assert.equal(recovered.status,'succeeded');assert.equal(f.state.creates,1);assert.equal(f.desktop.outbox(created).length,1);
});

test('stopping recovery before enqueue preserves the created task and prevents a later automatic first send',async t=>{
  const f=fixture(t),send=f.desktop.send.bind(f.desktop);
  f.desktop.send=async()=>{throw new Error('Synthetic queue unavailable');};
  await f.start();
  assert.equal((await f.lifecycle.cancel(requestId)).status,'cancelled');
  f.desktop.send=send;await f.lifecycle.tick();await f.lifecycle.get(requestId);
  assert.equal(f.store.thread(created).id,created);assert.equal(f.state.creates,1);
  assert.equal(f.desktop.outbox(created).length,0);assert.equal(f.state.sends.length,0);
});

test('a stale recovery batch cannot enqueue after cancellation while an earlier archive awaits its owner',async t=>{
  const f=fixture(t),send=f.desktop.send.bind(f.desktop);
  f.desktop.send=async()=>{throw new Error('Synthetic queue unavailable');};
  await f.start();f.desktop.send=send;
  const archiveThread='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',archiveRequest='dddddddd-dddd-7ddd-8ddd-dddddddddddd';
  const archived={id:archiveThread,title:'Independent archive',cwd:f.directory,archived:false};
  f.state.extraThreads.push(archived);f.lifecycle.sync();
  let block=false,entered,release;
  const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.lifecycle.archive=async payload=>{
    const plan={fingerprint:'same',threadIds:[archiveThread],descendantCount:0,rootArchived:archived.archived};
    if(payload.operation==='inspect'){
      if(block){entered();await gate;}
      return {...plan,status:block?'ready':'waiting'};
    }
    archived.archived=true;return {...plan,status:'archived',verified:true};
  };
  f.lifecycle.startArchive(archiveThread,{requestId:archiveRequest,archived:true});
  await f.lifecycle.running.get(archiveRequest);
  block=true;const tick=f.lifecycle.tick();await waiting;
  assert.equal((await f.lifecycle.cancel(requestId)).status,'cancelled');
  release();await tick;
  assert.equal(f.lifecycle.row(requestId).status,'cancelled');
  assert.equal(f.desktop.outbox(created).length,0);assert.equal(f.state.sends.length,0);
});

test('old unverified creations do not consume the batch reserved for verified handoff recovery',async t=>{
  const f=fixture(t),send=f.desktop.send.bind(f.desktop);
  f.desktop.send=async()=>{throw new Error('Synthetic queue unavailable');};
  await f.start();f.desktop.send=send;
  const insert=f.store.db.prepare("INSERT INTO lifecycle_operations VALUES(?,'create',?,'unused','{}','unknown',NULL,NULL,1,1)");
  for(let n=0;n<50;n++)insert.run(`aaaaaaaa-aaaa-7aaa-8aaa-${String(n).padStart(12,'0')}`,`eeeeeeee-eeee-7eee-8eee-${String(n).padStart(12,'0')}`);
  await f.lifecycle.tick();
  assert.equal(f.lifecycle.row(requestId).status,'succeeded');assert.equal(f.desktop.outbox(created).length,1);
  assert.equal(f.state.creates,1);
});

test('the creation result is based on durable readback even if the queue call returns or throws incorrectly',async t=>{
  await t.test('unpersisted success is not accepted',async t=>{
    const f=fixture(t);
    f.desktop.send=async(id,input)=>({requestId:input.requestId,status:'queued'});
    const {settled}=await f.start();
    assert.equal(settled.status,'unknown');assert.equal(settled.code,'initial_message_not_queued');
    assert.equal(f.desktop.outbox(created).length,0);
  });
  await t.test('persisted queue survives a late exception',async t=>{
    const f=fixture(t),send=f.desktop.send.bind(f.desktop);
    f.desktop.send=async(...args)=>{await send(...args);throw new Error('Synthetic lost return');};
    const {settled}=await f.start();
    assert.equal(settled.status,'succeeded');assert.equal(settled.initialMessage.status,'queued');
    assert.equal(f.desktop.outbox(created).length,1);assert.equal(f.state.creates,1);
  });
});

test('a bare interrupted dispatch reservation is not treated as durable enqueue or automatically replayed',async t=>{
  const f=fixture(t);let attempts=0;
  f.desktop.send=async(id,input)=>{
    attempts++;
    f.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)")
      .run(input.requestId,id,createHash('sha256').update(input.text).digest('hex'),Date.now());
    throw new Error('Simulated exit between reservation and durable queue');
  };
  const {settled}=await f.start();
  assert.equal(settled.status,'unknown');assert.equal(settled.code,'initial_message_unconfirmed');
  f.restart();f.desktop.startQueue();
  const send=f.desktop.send.bind(f.desktop);
  f.desktop.send=(...args)=>{attempts++;return send(...args);};
  for(let n=0;n<3;n++){await f.lifecycle.get(requestId);await f.lifecycle.tick();}
  const recovered=f.lifecycle.receipt(f.lifecycle.row(requestId));
  assert.equal(recovered.status,'unknown');assert.equal(recovered.initialMessage.status,'unknown');
  assert.equal(f.state.creates,1);assert.equal(attempts,1);assert.equal(f.state.sends.length,0);
  assert.equal(f.desktop.outbox(created).length,0);assert.equal(JSON.parse(f.lifecycle.row(requestId).payload).initialQuery,query);
});
