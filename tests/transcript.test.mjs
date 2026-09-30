import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';

test('saved transcript is readable while native history is blocked, without granting execution capabilities',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pocket-transcript-')),id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  let finish,started;const pending=new Promise(resolve=>started=resolve);
  const app=makeApp({dataDir:dir,readSource:()=>({threads:[{id,title:'Test',cwd:'/fixture',archived:false}],projects:[],sourceInfo:{}}),
    desktopRequest:()=>new Promise(resolve=>{finish=resolve;started();}),
    readHistory:()=>({messages:[{id:'new',role:'assistant',text:'已写入磁盘的回复'}],hasMore:true,turnTiming:{turnId:'turn',status:'completed'},canSend:true,queueReady:true,pendingRequests:[{key:'must-not-leak'}]})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{finish?.({ok:true,source:'desktop',runtime:'idle',canSend:true,messages:[]});await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,headers={Authorization:`Bearer ${app.auth.localToken}`};
  const history=fetch(base+`/api/tasks/${id}/history`,{headers}).then(r=>r.json());await pending;
  const r=await fetch(base+`/api/tasks/${id}/transcript`,{headers});assert.equal(r.status,200);
  const data=await r.json();assert.equal(data.messages[0].id,'new');assert.equal(data.source,'rollout');
  assert.equal(data.canSend,undefined);assert.equal(data.queueReady,undefined);assert.equal(data.pendingRequests,undefined);
  assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('server-timing'),/transcript/);
  assert.equal((await fetch(base+`/api/tasks/${id}/transcript`)).status,401);
  assert.equal((await fetch(base+`/api/tasks/${id}/transcript`,{headers:{...headers,Origin:'https://elsewhere.test'}})).status,403);
  finish({ok:true,source:'desktop',runtime:'idle',canSend:true,messages:[]});await history;
});
