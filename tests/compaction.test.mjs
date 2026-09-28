import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {NavigatorStore} from '../server/store.mjs';
import {DesktopService} from '../server/desktop.mjs';
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',rid='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'pocket-compact-'));const store=new NavigatorStore(dir);
 store.sync({threads:[{id,title:'Fixture',archived:false}],projects:[],sourceInfo:{}});
 const state={calls:0,sendCalls:0,result:{ok:true},history:{ok:true,source:'desktop',runtime:'idle',canSend:true,canCompact:true,queueReady:true,compaction:{active:false,latestId:'old',completed:true,turnStatus:'completed'},messages:[]}};
 const request=async p=>{if(p.operation==='history')return state.history;if(p.operation==='send'){state.sendCalls++;return {ok:true};}state.calls++;assert.equal(p.operation,'compact');assert.equal(p.expectedCompactionId,'old');return state.result;};
 const service=new DesktopService(store,'/fixture',request);
 t.after(()=>{service.stopQueue();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,state,service,request};
}
test('compaction is deduplicated and completion requires a new completed native item',async t=>{
 const {service:s,state}=fixture(t);
 assert.equal((await s.compact(id,{requestId:rid})).status,'accepted');
 assert.equal((await s.compact(id,{requestId:rid})).status,'accepted');assert.equal(state.calls,1);
 assert.equal((await s.history(id)).canCompact,false);
 state.history={...state.history,compaction:{active:true,latestId:'new',completed:false}};s.cache.clear();await s.history(id);
 assert.equal(s.getCompactionReceipt(id,rid).status,'accepted');
 state.history={...state.history,compaction:{active:false,latestId:'new',completed:true,turnStatus:'completed'}};s.cache.clear();await s.history(id);
 assert.equal(s.getCompactionReceipt(id,rid).status,'completed');
 assert.equal((await s.history(id)).canCompact,true);
});
test('unknown compaction survives restart without retry and cannot be replaced by another request',async t=>{
 const {service:s,state,store,request}=fixture(t);state.result={ok:false,sent:null,code:'dispatch_unknown'};
 assert.equal((await s.compact(id,{requestId:rid})).status,'unknown');
 const restarted=new DesktopService(store,'/fixture',request);restarted.startQueue();restarted.stopQueue();
 assert.equal((await restarted.compact(id,{requestId:rid})).status,'unknown');
 await assert.rejects(restarted.compact(id,{requestId:'cccccccc-cccc-7ccc-8ccc-cccccccccccc'}),e=>e.status===409);
 assert.equal(state.calls,1);
});
test('idle compaction holds queued work until native completion without deleting it',async t=>{
 const {service:s,state}=fixture(t);
 await s.send(id,{requestId:rid,text:'Later',enqueue:true});
 assert.equal((await s.history(id)).canCompact,true);
 assert.equal((await s.compact(id,{requestId:rid})).status,'accepted');
 await s.processQueue();assert.equal(state.sendCalls,0);assert.equal(s.outbox(id).length,1);
 state.history.compaction={active:false,latestId:'new',completed:true,turnStatus:'completed'};s.cache.clear();
 await s.history(id);await s.processQueue();
 assert.equal(state.sendCalls,1);assert.equal(s.outbox(id).length,0);
});
test('active native tasks and unsupported overrides still reject compaction',async t=>{
 const {service:s,state}=fixture(t);
 state.history={...state.history,runtime:'active',canCompact:false};
 await assert.rejects(s.compact(id,{requestId:rid}),e=>e.status===409);
 await assert.rejects(s.compact(id,{requestId:rid,model:'override'}),e=>e.status===400);
 assert.equal(state.calls,0);
});
