import test from 'node:test';
import assert from 'node:assert/strict';
import { worker } from './helpers/worker-profile.mjs';
const base='https://x.fangs.cc',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',key='a'.repeat(64);
const env={NAVIGATOR_MACHINE_KEYS:JSON.stringify({wandou:'b'.repeat(64)}),NAVIGATOR_CONNECTION:{get:async key=>({connected:true,machineId:key==='origin'?'ged':'wandou',publicOrigin:`https://${key==='origin'?'ged':'wandou'}.trycloudflare.com`})}};
function fixture(t,response){const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return response(url,options);};t.after(()=>{globalThis.fetch=original;});return calls;}
const request=(path,options={})=>new Request(base+path,options);

test('video ranges and identity survive both machine routes while ordinary file requests get no range headers',async t=>{
  const calls=fixture(t,(url,options)=>new Response(options.method==='HEAD'?null:new Uint8Array([0,1]),{status:options.method==='HEAD'?200:206,headers:{'X-Pocket-Machine':new URL(url).hostname.startsWith('wandou')?'wandou':'ged','Content-Type':'video/mp4','Content-Length':options.method==='HEAD'?'99':'2','Content-Range':'bytes 0-1/99','Accept-Ranges':'bytes',ETag:'"fixture"'}}));
  for(const prefix of ['/api','/api/machines/wandou'])for(const method of ['GET','HEAD']){
    const result=await worker.fetch(request(`${prefix}/tasks/${id}/files/${key}?video=1`,{method,headers:{Range:'bytes=0-1','If-Range':'"fixture"',Cookie:'navigator_session=ged; navigator_session_wandou=wandou',Authorization:'Bearer do-not-forward'}}),env);
    const call=calls.at(-1);assert.equal(call.options.headers.get('Range'),'bytes=0-1');assert.equal(call.options.headers.get('If-Range'),'"fixture"');assert.equal(call.options.headers.get('Authorization'),null);
    assert.equal(call.options.headers.get('Cookie'),prefix.includes('wandou')?'navigator_session=wandou':'navigator_session=ged');
    assert.equal(result.status,method==='HEAD'?200:206);assert.equal(result.headers.get('accept-ranges'),'bytes');assert.equal(result.headers.get('etag'),'"fixture"');assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal((await result.arrayBuffer()).byteLength,method==='HEAD'?0:2);
  }
  await(await worker.fetch(request(`/api/tasks/${id}/files/${key}`,{headers:{Range:'bytes=0-1','If-Range':'"fixture"'}}),env)).arrayBuffer();
  assert.equal(calls.at(-1).options.headers.get('Range'),null);assert.equal(calls.at(-1).options.headers.get('If-Range'),null);
});

test('video streaming outlives the header deadline and cancellation aborts the upstream body',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
  const calls=fixture(t,()=>new Response(new ReadableStream({pull(){},cancel(){cancelled=true;}}),{headers:{'X-Pocket-Machine':'ged','Content-Type':'video/mp4'}}));
  const result=await worker.fetch(request(`/api/tasks/${id}/files/${key}?video=1`),env);
  t.mock.timers.tick(21000);assert.equal(calls[0].options.signal.aborted,false,'healthy bodies must not stop at 20 seconds');
  await result.body.cancel();assert.equal(cancelled,true);assert.equal(calls[0].options.signal.aborted,true);
});

test('video proxy closes rejected responses and never accepts a wrong-machine stream or redirect',async t=>{
  let wrong=true,cancelled=0;
  fixture(t,()=>new Response(new ReadableStream({pull(){},cancel(){cancelled++;}}),{status:wrong?200:302,headers:{'X-Pocket-Machine':wrong?'other':'ged',Location:'https://other.example'}}));
  let response=await worker.fetch(request(`/api/tasks/${id}/files/${key}?video=1`),env);assert.equal(response.status,503);assert.equal(cancelled,1);
  wrong=false;response=await worker.fetch(request(`/api/tasks/${id}/files/${key}?video=1`),env);assert.equal(response.status,503);assert.equal(cancelled,2);
});

test('cross-site video requests and source impersonation are rejected before fetch',async t=>{
  const calls=fixture(t,()=>{throw Error('Must not fetch');});
  for(const headers of [{Origin:'https://other.example'},{'Sec-Fetch-Site':'cross-site'}]){
    const response=await worker.fetch(request(`/api/tasks/${id}/files/${key}?video=1`,{headers}),env);assert.equal(response.status,403);
  }
  assert.equal(calls.length,0);
});
