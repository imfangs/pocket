import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { makeApp } from '../server/index.mjs';
import { MessageFiles } from '../server/message-files.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t,machineId='ged') {
  const directory=mkdtempSync(join(tmpdir(),'pocket-video-http-')),cwd=join(directory,'project');mkdirSync(cwd);
  const path=join(cwd,"视频 '样本'.mp4"), bytes=Buffer.alloc(150000,17);
  Buffer.from('000000186674797069736f6d0000020069736f6d61766331','hex').copy(bytes);writeFileSync(path,bytes);
  const fake=join(cwd,'fake.mp4');writeFileSync(fake,'<html>not a video</html>');
  const text=`![视频](<${path}>)\n\n[伪装文件](<${fake}>)`,message={id:'sample',role:'assistant',phase:'final',text};
  let opens=0;
  const app=makeApp({dataDir:join(directory,'data'),codexHome:directory,machineId,
    readSource:()=>({threads:[id,other].map(id=>({id,cwd,title:'Video fixture',updatedAt:1})),projects:[],sourceInfo:{}}),
    readHistory:()=>({source:'rollout',messages:[message]}),desktopRequest:async()=>({ok:true,source:'desktop',runtime:'idle',messages:[message]}),
    openThread:async()=>{opens++;throw Error('No native opening');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,auth={Authorization:`Bearer ${app.auth.localToken}`};
  const read=(path,options={})=>fetch(base+path,{...options,headers:{...auth,...options.headers}});
  const transcript=await(await read(`/api/tasks/${id}/transcript`)).json();
  const files=transcript.messages[0].files;
  return {app,base,read,bytes,video:files[path].url+'?video=1',download:files[path].url,fake:files[fake].url+'?video=1',opens:()=>opens};
}

test('authenticated video GET, HEAD, seek and download expose exact ranges with private headers',async t=>{
  const f=await fixture(t);
  let response=await f.read(f.video,{headers:{Range:'bytes=0-1'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/mp4');
  assert.equal(response.headers.get('content-range'),`bytes 0-1/${f.bytes.length}`);assert.equal(response.headers.get('content-length'),'2');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes.subarray(0,2));
  for(const [name,value] of Object.entries({'cache-control':'no-store','accept-ranges':'bytes','cross-origin-resource-policy':'same-origin','x-content-type-options':'nosniff','x-pocket-machine':'ged'}))assert.equal(response.headers.get(name),value);
  const etag=response.headers.get('etag');assert(etag);
  response=await f.read(f.video,{headers:{Range:'bytes=140000-','If-Range':etag}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes.subarray(140000));
  response=await f.read(f.video,{method:'HEAD',headers:{Range:'bytes=0-1'}});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(f.bytes.length));assert.equal((await response.arrayBuffer()).byteLength,0);
  response=await f.read(f.video,{headers:{Range:'bytes=999999-','If-Range':'"old"'}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  response=await f.read(f.video,{headers:{Range:'bytes=999999-'}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),`bytes */${f.bytes.length}`);assert.equal((await response.arrayBuffer()).byteLength,0);
  response=await f.read(f.video+'&download=1',{headers:{Range:'bytes=0-23'}});assert.equal(response.status,206);assert.match(response.headers.get('content-disposition'),/^attachment;/);await response.arrayBuffer();
  response=await f.read(f.download);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  assert.equal(f.opens(),0);
});

test('video routes keep authentication, grant identity, query and container boundaries',async t=>{
  const f=await fixture(t,'wandou');
  assert.equal((await fetch(f.base+f.video)).status,401);
  assert.equal((await f.read(f.video,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.read(f.video.replace(id,other))).status,404);
  assert.equal((await f.read(`/api/tasks/${id}/files/${'0'.repeat(64)}?video=1`)).status,404);
  for(const suffix of ['&path=/etc/passwd','&video=0','&download=0'])assert.equal((await f.read(f.video+suffix)).status,400);
  assert.equal((await f.read(f.fake)).status,415);
  const response=await f.read(f.video,{headers:{Range:'bytes=-12'}});assert.equal(response.status,206);assert.equal(response.headers.get('x-pocket-machine'),'wandou');assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes.subarray(-12));
});

test('service shutdown cancels active video responses and refuses new streams without blocking normal files', {timeout:5000}, async t=>{
  const f=await fixture(t);let first=true,closes=0,finished;
  const closed=new Promise(resolve=>{finished=resolve;});
  const stream=new Readable({read(){if(first){first=false;this.push(Buffer.alloc(1024));}}});
  t.mock.method(MessageFiles.prototype,'openVideo',async()=>({status:200,headers:{'Content-Type':'video/mp4','Content-Length':'100000'},stream,
    close:async()=>{closes++;stream.destroy();finished();}}));
  const response=await f.read(f.video),reader=response.body.getReader();assert.equal((await reader.read()).value.length,1024);
  f.app.stopVideoStreams();await closed;await assert.rejects(reader.read());assert.equal(closes,1);
  assert.equal((await f.read(f.video)).status,503);
  const ordinary=await f.read(f.download);assert.equal(ordinary.status,200);assert.deepEqual(Buffer.from(await ordinary.arrayBuffer()),f.bytes);
});

test('shutdown before HEAD headers closes a request even when the file opener resolves after cancellation', {timeout:5000}, async t=>{
  const f=await fixture(t);let entered,release,finished,closes=0;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),closed=new Promise(resolve=>{finished=resolve;});
  t.mock.method(MessageFiles.prototype,'openVideo',async()=>{entered();await gate;return{status:200,headers:{'Content-Type':'video/mp4','Content-Length':'100'},stream:null,close:async()=>{closes++;finished();}};});
  const pending=assert.rejects(f.read(f.video,{method:'HEAD'}));await ready;f.app.stopVideoStreams();release();
  await pending;await closed;assert.equal(closes,1);
});
