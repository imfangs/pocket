import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';
async function fixture(t) {
 const dataDir=mkdtempSync(join(tmpdir(),'pocket-catalog-wire-'));
 const threads=Array.from({length:160},(_,i)=>({id:`aaaaaaaa-aaaa-7aaa-8aaa-${String(i).padStart(12,'0')}`,title:`项目任务 ${i}：继续处理消息和任务状态`,cwd:'/fixture/workspace',archived:false,updatedAt:1000}));
 const app=makeApp({dataDir,readSource:()=>({threads,projects:[],sourceInfo:{syncedAt:1000}})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));rmSync(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const call=(path='/api/catalog',headers={},method='GET')=>new Promise((resolve,reject)=>{
  const req=http.request(base+path,{method,headers:{Authorization:`Bearer ${app.auth.localToken}`,...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(method==='POST'?'{}':undefined);
 });return{call,base};
}
test('catalog gzip removes bulk transfer without changing a single field or caching private data',async t=>{
 const {call}=await fixture(t);const plain=await call();const compressed=await call('/api/catalog',{'Accept-Encoding':'gzip, br'});
 assert.equal(compressed.status,200);assert.equal(compressed.headers['content-encoding'],'gzip');
 assert.equal(compressed.headers['cache-control'],'no-store');assert.match(compressed.headers.vary,/Accept-Encoding/i);
 assert.deepEqual(JSON.parse(gunzipSync(compressed.body)),JSON.parse(plain.body));
 assert.ok(compressed.body.length<plain.body.length*0.35);assert.equal(Number(compressed.headers['content-length']),compressed.body.length);
});
test('sync uses compression and clients that reject gzip receive plain JSON',async t=>{
 const {call,base}=await fixture(t);const plain=await call();const csrf=JSON.parse(plain.body).csrfToken;
 const response=await call('/api/sync',{'Accept-Encoding':'gzip',Origin:base,'X-Navigator-Token':csrf,'Content-Type':'application/json'},'POST');
 assert.equal(response.status,200);assert.equal(response.headers['content-encoding'],'gzip');assert.equal(JSON.parse(gunzipSync(response.body)).threads.length,160);
 for(const accept of ['br','gzip;q=0','gzip;q=0, *;q=1','gzip;q=bogus','gzip;q=0.2, identity;q=1']){
  const r=await call('/api/catalog',{'Accept-Encoding':accept});assert.equal(r.headers['content-encoding'],undefined);assert.equal(JSON.parse(r.body).threads.length,160);
 }
 const wildcard=await call('/api/catalog',{'Accept-Encoding':'*;q=0.5'});assert.equal(wildcard.headers['content-encoding'],'gzip');
});
test('compression never bypasses authentication or origin checks',async t=>{
 const {call}=await fixture(t);
 const anonymous=await call('/api/catalog',{Authorization:'','Accept-Encoding':'gzip'});assert.equal(anonymous.status,401);assert.equal(anonymous.headers['content-encoding'],undefined);
 const cross=await call('/api/sync',{Origin:'https://elsewhere.test','Accept-Encoding':'gzip','Content-Type':'application/json'},'POST');assert.equal(cross.status,403);
});
