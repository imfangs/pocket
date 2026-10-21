import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';
import { runBridge } from '../server/bridge-process.mjs';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';

const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
test('slow sends acknowledge promptly and receipt polling never dispatches again', async t => {
  const dataDir=mkdtempSync(join(tmpdir(),'pocket-slow-send-'));let sends=0,finish;
  const app=makeApp({dataDir,codexHome:dataDir,dispatchReplyWaitMs:10,readSource:()=>({threads:[{id,title:'Test',cwd:'/fixture',archived:false}],projects:[],sourceInfo:{}}),
    desktopRequest:async payload=>{if(payload.operation==='send'){sends++;return new Promise(resolve=>{finish=resolve;setTimeout(()=>resolve({ok:true,turnId:'turn'}),250);});}return {ok:true,source:'desktop',runtime:'idle',canSend:true,messages:[]};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{finish?.({ok:true});await new Promise(resolve=>app.server.close(resolve));rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const headers={Authorization:`Bearer ${app.auth.localToken}`};
  const catalog=await fetch(base+'/api/catalog',{headers}).then(r=>r.json());
  const requestId='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const post=()=>fetch(base+`/api/tasks/${id}/messages`,{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json','X-Navigator-Token':catalog.csrfToken},body:JSON.stringify({requestId,text:'one message'})});
  const first=await post();assert.equal(first.status,202);assert.equal((await first.json()).status,'pending');
  const duplicate=await post();assert.equal((await duplicate.json()).status,'pending');assert.equal(sends,1);
  finish({ok:true,turnId:'turn'});await new Promise(resolve=>setImmediate(resolve));
  const receipt=await fetch(base+`/api/tasks/${id}/messages/${requestId}`,{headers}).then(r=>r.json());
  assert.equal(receipt.status,'accepted');assert.equal(sends,1);
});

test('bridge timeout before dispatch is retryable only after its phase stream is drained', async()=>{
  const result=await runBridge({operation:'send'}, {command:process.execPath,args:['-e',"process.stderr.write('POCKET_BRIDGE_PHASE_V1 preflight\\n');setInterval(()=>{},1000)"],timeoutMs:300});
  assert.deepEqual(result,{ok:false,code:'desktop_preflight_timeout',sent:false});
});
test('dispatch marker or a legacy bridge keeps interrupted delivery unknown',async()=>{
  for(const marker of ['POCKET_BRIDGE_PHASE_V1 preflight\nPOCKET_BRIDGE_PHASE_V1 dispatch\n','']) {
    const result=await runBridge({operation:'send'},{command:process.execPath,args:['-e',`process.stderr.write(${JSON.stringify(marker)});setInterval(()=>{},1000)`],timeoutMs:300});
    assert.equal(result.sent,null);assert.equal(result.code,'dispatch_unknown');
  }
  const racing=await runBridge({operation:'send'},{command:process.execPath,args:['-e',"process.stderr.write('POCKET_BRIDGE_PHASE_V1 preflight\\n');process.on('SIGTERM',()=>{process.stderr.write('POCKET_BRIDGE_PHASE_V1 dispatch\\n');process.exit(0)});setInterval(()=>{},1000)"],timeoutMs:300});
  assert.equal(racing.sent,null);
});

test('a confirmed delivery is never downgraded by a late bridge failure',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'pocket-confirmation-'));const store=new NavigatorStore(directory);
  store.sync({threads:[{id,title:'Test',cwd:'/fixture',archived:false}],projects:[],sourceInfo:{}});
  let finish;const requestId='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const service=new DesktopService(store,'/fixture',async p=>p.operation==='send'?new Promise(resolve=>finish=resolve):{ok:true,source:'desktop',runtime:'idle',canSend:true,messages:[{id:'message',clientMessageId:requestId,turnId:'confirmed-turn'}]});
  t.after(()=>{service.stopQueue();store.close();rmSync(directory,{recursive:true,force:true});});
  const sending=service.send(id,{requestId,text:'once'});
  await service.loadHistory(id);finish({ok:false,sent:null,code:'dispatch_unknown'});
  const result=await sending;assert.equal(result.status,'accepted');assert.equal(result.turnId,'confirmed-turn');assert.equal(result.code,null);
  const pending='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
  store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)").run(pending,id,'hash',Date.now());
  service.startQueue();assert.equal(service.getReceipt(id,pending).status,'unknown');assert.equal(service.getReceipt(id,pending).code,'submission_interrupted');
});
