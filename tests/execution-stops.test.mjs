import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {NavigatorStore} from '../server/store.mjs';import {DesktopService} from '../server/desktop.mjs';
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const turn='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const rid=n=>`bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12,'0')}`;
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'pocket-stop-'));const store=new NavigatorStore(dir);
 store.sync({threads:[{id,title:'Fixture',archived:false}],projects:[],sourceInfo:{}});
 const state={active:true,status:'inProgress',calls:[],unknown:false};
 const request=async p=>{if(p.operation==='history')return {ok:true,source:'desktop',runtime:state.active?'active':'idle',canSend:true,canStop:state.active,activeTurnId:state.active?turn:null,latestTurnId:turn,latestTurnStatus:state.status,queueReady:!state.active&&state.status==='completed',recentTurns:[{id:turn,status:state.status}],messages:[]};
  state.calls.push(p);if(p.operation==='stop')return state.unknown?{ok:false,sent:null}:{ok:true};
  assert.equal(p.operation,'send');state.active=true;return {ok:true};};
 const service=new DesktopService(store,'/fixture',request);
 t.after(()=>{service.stopQueue();store.close();rmSync(dir,{recursive:true,force:true});});return {store,state,service,request};
}
test('stop pauses queued messages immediately, and only native interrupted state confirms completion',async t=>{
 const {service:s,state}=fixture(t);await s.send(id,{requestId:rid(1),text:'Next',enqueue:true});
 const input={requestId:rid(2),expectedTurnId:turn};assert.equal((await s.stop(id,input)).status,'accepted');
 assert.equal((await s.stop(id,input)).status,'accepted');assert.equal(state.calls.length,1);
 assert.equal(s.stops.pause(id).stopId,rid(2));await s.processQueue();assert.equal(state.calls.length,1);
 state.active=false;state.status='interrupted';s.cache.clear();const h=await s.history(id);
 assert.equal(h.stopRequest.status,'stopped');assert.equal(h.queuePaused.stopId,rid(2));
 await s.processQueue();assert.equal(state.calls.length,1);
 await s.resumeQueue(id,{expectedStopId:rid(2)});await s.processQueue();
 assert.equal(state.calls.length,2);assert.equal(state.calls[1].delivery,'resume');assert.equal(state.calls[1].resumeAfterTurnId,turn);assert.equal(s.outbox(id).length,0);
});
test('natural completion is reported as ended, not as a successful interruption',async t=>{
 const {service:s,state}=fixture(t);await s.stop(id,{requestId:rid(1),expectedTurnId:turn});
 state.active=false;state.status='completed';s.cache.clear();await s.history(id);
 assert.equal(s.stops.receipt(id,rid(1)).status,'ended');
});
test('unknown stop requests and queue pause survive restart without replay',async t=>{
 const {service:s,state,store,request}=fixture(t);state.unknown=true;
 assert.equal((await s.stop(id,{requestId:rid(1),expectedTurnId:turn})).status,'unknown');
 const next=new DesktopService(store,'/fixture',request);next.startQueue();next.stopQueue();
 assert.equal(next.stops.pause(id).stopId,rid(1));
 assert.equal((await next.stop(id,{requestId:rid(1),expectedTurnId:turn})).status,'unknown');assert.equal(state.calls.length,1);
 await assert.rejects(()=>next.resumeQueue(id,{expectedStopId:rid(1)}),e=>e.status===409);
});
test('a stop arriving during a queue readiness read prevents the pending auto dispatch',async t=>{
 const {service:s,state,request}=fixture(t);await s.send(id,{requestId:rid(1),text:'Next',enqueue:true});
 let finish;s.request=p=>p.operation==='history'?new Promise(resolve=>{finish=resolve}):request(p);
 const processing=s.processQueue();await s.stop(id,{requestId:rid(2),expectedTurnId:turn});
 finish({ok:true,source:'desktop',runtime:'idle',queueReady:true,canSend:true,messages:[]});await processing;
 assert.deepEqual(state.calls.map(p=>p.operation),['stop']);assert.equal(s.outbox(id).length,1);
});
test('stale resume clicks cannot clear a newer stop pause and invalid overrides never dispatch',async t=>{
 const {service:s,state}=fixture(t);await assert.rejects(s.stop(id,{requestId:rid(1),expectedTurnId:turn,mode:'system'}),e=>e.status===400);
 await s.stop(id,{requestId:rid(1),expectedTurnId:turn});state.active=false;state.status='interrupted';s.cache.clear();await s.history(id);
 await assert.rejects(()=>s.resumeQueue(id,{expectedStopId:rid(2)}),e=>e.status===409);assert.ok(s.stops.pause(id));
});
