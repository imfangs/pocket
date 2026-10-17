import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api.ts';
const json=(body,machine,status=200)=>new Response(JSON.stringify(body),{status,headers:machine?{'X-Pocket-Machine':machine}:{}});

test('request, CSRF recovery and retry retain their captured machine and token despite another scope becoming active',async()=>{
 let scope='wandou',resolveFirst;const calls=[];
 const client=createApiClient(()=>scope,async(url,options)=>{calls.push({url,token:options.headers?.['X-Navigator-Token']});
  if(calls.length===1)return new Promise(resolve=>{resolveFirst=resolve});
  if(url==='/api/machines/wandou/catalog')return json({csrfToken:'new-wandou'},'wandou');
  return url.startsWith('/api/machines/')?json({from:'wandou'},'wandou'):json({from:'ged'},null);
 },()=>{});
 client.setToken('old-wandou','wandou');client.setToken('ged-token','ged');
 const pending=client.api('/api/tasks/id/priority','POST',{priority:true});scope='ged';resolveFirst(json({error:'请求已过期，请刷新页面'},'wandou',403));
 assert.deepEqual(await pending,{from:'wandou'});
 assert.deepEqual(calls,[{url:'/api/machines/wandou/tasks/id/priority',token:'old-wandou'},{url:'/api/machines/wandou/catalog',token:undefined},{url:'/api/machines/wandou/tasks/id/priority',token:'new-wandou'}]);
 await client.api('/api/tasks/id/priority','POST',{priority:false});assert.equal(calls.at(-1).token,'ged-token');
});
test('a response with the wrong or missing remote machine cannot expose its body',async()=>{
 for(const identity of ['ged',null]){let reads=0;const client=createApiClient(()=> 'wandou',async()=>({headers:new Headers(identity?{'X-Pocket-Machine':identity}:{}),json:async()=>{reads++;return {private:'wrong machine'}}}),()=>{});
  await assert.rejects(client.api('/api/catalog'),/来源不匹配/);assert.equal(reads,0);
 }
});
test('unknown selection never makes a request or borrows another machine token',async()=>{
 let calls=0;const client=createApiClient(()=>null,async()=>{calls++;return json({},'ged')},()=>{});
 assert.throws(()=>client.setToken('secret'),/请选择电脑/);await assert.rejects(client.api('/api/auth/status'),/请选择电脑/);assert.equal(calls,0);
});
test('expiry notification identifies only the machine whose request expired',async()=>{
 const expired=[];const client=createApiClient(()=> 'wandou',async()=>json({error:'expired'},'wandou',401),machine=>expired.push(machine));
 await assert.rejects(client.api('/api/catalog'),/expired/);assert.deepEqual(expired,['wandou']);
});
