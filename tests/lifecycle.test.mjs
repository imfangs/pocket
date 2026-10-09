import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';

const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', created='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const rid=n=>`bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12,'0')}`;
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pocket-lifecycle-'));
  const state={busy:true,version:'baseline',archived:false,creates:0,archives:0,opens:0,desktopReads:0};
  const threads=[{id,title:'Lifecycle fixture',cwd:dir,archived:false}];
  const app=makeApp({dataDir:dir,codexHome:dir,
    readSource:()=>({threads:threads.map(t=>({...t,archived:t.id===id?state.archived:t.archived})),projects:[],sourceInfo:{}}),
    readHistory:()=>({source:'rollout',runtime:'unavailable',canSend:false,messages:[],hint:'Saved'}),
    desktopRequest:async()=>{state.desktopReads++;return {ok:false,code:'desktop_unavailable'};},
    openThread:async()=>{state.opens++;},
    lifecycle:{
      locations:()=>[{id:'location',label:'Fixture',cwd:dir}],
      create:async()=>{state.creates++;threads.push({id:created,title:'Created fixture',cwd:dir,archived:false});return {status:'created',threadId:created,verified:true,processStopped:true};},
      archive:async p=>{
        const plan={fingerprint:state.version,threadIds:[id],descendantCount:0,rootArchived:state.archived};
        if(p.operation==='inspect') return {...plan,verified:!state.partial,
          status:state.partial||state.inspectBlocked?'blocked':state.archived?'archived':state.busy?'waiting':'ready',
          ...(state.partial?{code:'partial_subtree'}:{})};
        if(p.operation==='archive') {
          if(p.expectedFingerprint!==state.version)return {...plan,status:'changed'};
          if(state.busy)return {...plan,status:'waiting'};
          state.archives++;state.archived=true;return {...plan,status:'archived',rootArchived:true,verified:true};
        }
        state.archived=false;return {...plan,status:'restored',rootArchived:false,verified:true};
      },
      tickMs:100000,
    },
  });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth={Authorization:`Bearer ${app.auth.localToken}`};
  const catalog=await fetch(base+'/api/catalog',{headers:auth}).then(r=>r.json());
  const call=async(path,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{...auth,Origin:base,'Content-Type':'application/json','X-Navigator-Token':catalog.csrfToken},...(body?{body:JSON.stringify(body)}:{})});
    return {http:response.status,...await response.json()};
  };
  const settled=async(requestId)=>{
    for(let n=0;n<50;n++){
      const r=await call('/api/task-operations/'+requestId);
      if(r.status!=='pending')return r;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('Operation did not settle');
  };
  return{app,state,call,settled};
}

test('new conversation is created once without loading an owner before the first message',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/tasks/create-options')).locations.length,1);
  await f.call('/api/tasks','POST',{requestId:rid(1),locationId:'location'});
  const done=await f.settled(rid(1));
  assert.equal(done.status,'succeeded');assert.equal(done.thread.id,created);
  await f.call('/api/tasks','POST',{requestId:rid(1),locationId:'location'});
  assert.equal(f.state.creates,1);assert.equal(f.state.opens,0);
});

test('busy archive remains real and cancellable; waiting reads do not keep its owner loaded',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(2),archived:true});
  const waiting=await f.settled(rid(2));assert.equal(waiting.status,'waiting');
  const reads=f.state.desktopReads;
  const history=await f.call(`/api/tasks/${id}/history`);
  assert.equal(history.source,'rollout');assert.equal(history.canQueue,false);
  assert.equal(f.state.desktopReads,reads);assert.equal(f.state.archived,false);
  assert.equal((await f.call(`/api/tasks/${id}/messages`,'POST',{requestId:rid(3),text:'Must not send'})).http,409);
  const cancelled=await f.call(`/api/task-operations/${rid(2)}/cancel`,'POST',{});
  assert.equal(cancelled.status,'cancelled');assert.equal(f.state.archived,false);
});

test('waiting archive completes after writer release and the same conversation can be restored',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(4),archived:true});
  assert.equal((await f.settled(rid(4))).status,'waiting');
  f.state.busy=false;await f.app.lifecycle.tick();
  assert.equal((await f.settled(rid(4))).status,'succeeded');assert.equal(f.state.archives,1);
  assert.equal((await f.call('/api/catalog')).threads.find(t=>t.id===id).archived,true);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(5),archived:false});
  assert.equal((await f.settled(rid(5))).status,'succeeded');assert.equal(f.state.archived,false);
});

test('new activity stops a waiting archive instead of archiving the newer work',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(6),archived:true});
  assert.equal((await f.settled(rid(6))).status,'waiting');
  f.state.version='new-turn';f.state.busy=false;await f.app.lifecycle.tick();
  assert.equal((await f.settled(rid(6))).status,'changed');assert.equal(f.state.archives,0);
});

test('unprocessed outbox is retained and blocks archive',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/messages`,'POST',{requestId:rid(7),text:'Saved message',enqueue:true});
  const result=await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(8),archived:true});
  assert.equal(result.status,'rejected');assert.equal(result.code,'outbox_not_empty');
  assert.equal(f.state.archives,0);
});

test('restoring only the root does not require its descendants to be idle',async t=>{
  const f=await fixture(t);f.state.archived=true;f.state.inspectBlocked=true;f.app.sync();
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(9),archived:false});
  assert.equal((await f.settled(rid(9))).status,'succeeded');
  assert.equal(f.state.archived,false);
});

test('an archived root with an incomplete subtree is not reported as archive success',async t=>{
  const f=await fixture(t);f.state.archived=true;f.state.partial=true;f.app.sync();
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(10),archived:true});
  const result=await f.settled(rid(10));
  assert.equal(result.status,'rejected');assert.equal(result.code,'partial_subtree');
});

test('unknown archive reconciliation requires the entire original subtree to be archived',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(11),archived:true});
  await f.settled(rid(11));f.app.lifecycle.update(rid(11),'unknown','archive_unconfirmed');
  f.state.archived=true;f.state.partial=true;
  assert.equal((await f.call('/api/task-operations/'+rid(11))).status,'unknown');
});

test('cancelling while its readback is pending excludes the background archive worker',async t=>{
  const f=await fixture(t);
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(12),archived:true});
  await f.settled(rid(12));
  const archive=f.app.lifecycle.archive;
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  f.app.lifecycle.archive=async payload=>{
    if(payload.operation==='inspect'){entered();await new Promise(resolve=>{release=resolve;});}
    return archive(payload);
  };
  const cancelling=f.call(`/api/task-operations/${rid(12)}/cancel`,'POST',{});
  await started;f.state.busy=false;
  const tick=f.app.lifecycle.tick();release();
  assert.equal((await cancelling).status,'cancelled');await tick;
  assert.equal(f.state.archives,0);assert.equal(f.state.archived,false);
});

test('an unknown creation without a checkpoint is never started again by polling',async t=>{
  const f=await fixture(t);
  f.app.lifecycle.create=async()=>{f.state.creates++;return {status:'unknown',code:'create_unconfirmed'};};
  await f.call('/api/tasks','POST',{requestId:rid(13),locationId:'location'});
  assert.equal((await f.settled(rid(13))).status,'unknown');
  await f.call('/api/tasks','POST',{requestId:rid(13),locationId:'location'});
  await f.call('/api/task-operations/'+rid(13));
  assert.equal(f.state.creates,1);
});

test('archived read-only open cannot bypass an in-progress restore',async t=>{
  const f=await fixture(t);f.state.archived=true;f.app.sync();
  const archive=f.app.lifecycle.archive;
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  f.app.lifecycle.archive=async payload=>{
    if(payload.operation==='restore'){entered();await new Promise(resolve=>{release=resolve;});}
    return archive(payload);
  };
  await f.call(`/api/tasks/${id}/archive`,'POST',{requestId:rid(14),archived:false});
  await started;
  assert.equal((await f.call(`/api/open/${id}`,'POST',{})).http,409);
  assert.equal(f.state.opens,0);release();
  assert.equal((await f.settled(rid(14))).status,'succeeded');
});

test('management endpoints preserve authentication and CSRF checks',async t=>{
  const f=await fixture(t),base=`http://127.0.0.1:${f.app.server.address().port}`;
  assert.equal((await fetch(base+'/api/tasks/create-options')).status,401);
  assert.equal((await fetch(base+'/api/task-operations')).status,401);
  const response=await fetch(base+'/api/tasks',{method:'POST',headers:{Authorization:`Bearer ${f.app.auth.localToken}`,'Content-Type':'application/json',Origin:base},body:JSON.stringify({requestId:rid(15),locationId:'location'})});
  assert.equal(response.status,403);assert.equal(f.state.creates,0);
});

test('a definitely unstarted creator is rejected instead of becoming an unrecoverable unknown',async t=>{
  const f=await fixture(t);
  f.app.lifecycle.create=async()=>({ok:false,sent:false,code:'desktop_unavailable'});
  await f.call('/api/tasks','POST',{requestId:rid(16),locationId:'location'});
  assert.equal((await f.settled(rid(16))).status,'rejected');
});

test('an unresolved creation can stop tracking without replaying or deleting a possible native thread',async t=>{
  const f=await fixture(t);
  f.app.lifecycle.create=async()=>{f.state.creates++;return {status:'unknown'};};
  await f.call('/api/tasks','POST',{requestId:rid(17),locationId:'location'});await f.settled(rid(17));
  const result=await f.call(`/api/task-operations/${rid(17)}/cancel`,'POST',{});
  assert.equal(result.status,'cancelled');assert.equal(f.state.creates,1);assert.equal(f.state.archives,0);
});

test('quick creation accepts a 16000-character query over the authenticated HTTP endpoint',async t=>{
  const f=await fixture(t),initialQuery='合'.repeat(16000);
  const started=await f.call('/api/tasks','POST',{requestId:rid(18),locationId:'location',initialQuery});
  assert.equal(started.http,202);
  const done=await f.settled(rid(18));
  assert.equal(done.status,'succeeded');assert.equal(done.creationStatus,'created');assert.equal(done.initialMessage.status,'queued');
  assert.equal(f.app.lifecycle.desktop.outbox(created)[0].text,initialQuery);
  assert.equal(JSON.stringify(done).includes(initialQuery),false);
  const invalid=await f.call('/api/tasks','POST',{requestId:rid(19),locationId:'location',initialQuery:initialQuery+'合'});
  assert.equal(invalid.http,400);assert.equal(f.state.creates,1);
});
