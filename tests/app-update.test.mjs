import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppUpdate,parseAppVersion,htmlBuildId} from '../src/appUpdate.ts';
import {versionManifest,frontendVersion} from '../bin/build-version.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

const oldId='a'.repeat(64),newId='b'.repeat(64),version={id:newId,assets:['/assets/index-next.js','/assets/site-next.css']};
function fixture(){
 const state={version,entryId:newId,blocker:null,headType:null,requests:[],shown:[],reloads:0,beforeHead:null};
 const update=createAppUpdate({currentId:oldId,request:async(path,options)=>{
  state.requests.push({path,method:options?.method||'GET',cache:options?.cache});
  if(path==='/pocket-version.json')return Response.json(state.version);
  if(path==='/')return new Response(`<meta name="pocket-build" content="${state.entryId}">`,{headers:{'content-type':'text/html'}});
  await state.beforeHead?.();return new Response('',{headers:{'content-type':state.headType||(path.endsWith('.css')?'text/css':'application/javascript')}});
 },blocker:()=>state.blocker,onAvailable:v=>state.shown.push(v),reload:()=>state.reloads++});
 return {state,update};
}
test('checking a version is read-only, a matching build stays quiet, and discovery never reloads',async()=>{
 const {state,update}=fixture();state.version={...version,id:oldId};await update.check();assert.deepEqual(state.shown,[null]);
 state.version=version;await update.check();assert.equal(state.shown.at(-1).id,newId);assert.equal(state.reloads,0);
 assert.ok(state.requests.every(r=>r.method==='GET'&&r.cache==='no-store'));
});
test('explicit update checks all assets and the manifest again before reloading once',async()=>{
 const {state,update}=fixture();assert.equal((await update.apply()).status,'updated');assert.equal(state.reloads,1);
 assert.equal(state.requests.filter(r=>r.method==='HEAD').length,2);assert.equal(state.requests.filter(r=>r.path==='/pocket-version.json').length,2);
 assert.ok(state.requests.every(r=>['GET','HEAD'].includes(r.method)));
});
test('unfinished input blocks before any request and is checked again after network waiting',async()=>{
 const {state,update}=fixture();state.blocker='unsent draft';assert.equal((await update.apply()).status,'blocked');assert.equal(state.requests.length,0);
 state.blocker=null;state.beforeHead=()=>{state.blocker='new draft during checks';};assert.equal((await update.apply()).status,'blocked');assert.equal(state.reloads,0);
 state.blocker=null;assert.equal(state.reloads,0,'clearing a draft must not trigger an automatic update');
});
test('HTML fallback assets, malformed versions and a changing deployment never reload',async()=>{
 const {state,update}=fixture();state.headType='text/html';assert.equal((await update.apply()).status,'unavailable');assert.equal(state.reloads,0);
 state.headType=null;state.version={id:newId,assets:['https://evil.test/leak.js']};assert.equal((await update.apply()).status,'unavailable');
 state.version=version;state.beforeHead=()=>{state.version={...version,id:'c'.repeat(64)};};assert.equal((await update.apply()).status,'unavailable');assert.equal(state.reloads,0);
 for(const value of [null,{}, {...version,id:'short'}, {...version,assets:[]},{...version,assets:['/api/catalog']},{...version,assets:['/assets/a.js','/assets/a.js']}])assert.equal(parseAppVersion(value),null);
});
test('a new manifest and ready chunks cannot reload an old or missing HTML entry',async()=>{
 const {state,update}=fixture();state.entryId=oldId;assert.equal((await update.apply()).status,'unavailable');assert.equal(state.reloads,0);
 state.entryId='';assert.equal((await update.apply()).status,'unavailable');assert.equal(state.reloads,0);
 assert.equal(htmlBuildId(`<!-- <meta name="pocket-build" content="${oldId}"> --><meta content="${newId}" name="pocket-build">`),newId);
});
test('repeated clicks and leaving the app cannot cause an extra or late reload',async()=>{
 const {state,update}=fixture();let release;const wait=new Promise(resolve=>release=resolve);state.beforeHead=()=>wait;
 const first=update.apply();await Promise.resolve();assert.equal((await update.apply()).status,'unavailable');update.stop();release();await first;assert.equal(state.reloads,0);
});
test('build metadata contains only build IDs and emitted frontend asset paths',()=>{
 const emitted=[];versionManifest(newId).generateBundle.call({emitFile:v=>emitted.push(v)},null,{'assets/a.js':{},'assets/b.css':{},'index.html':{},'assets/a.js.map':{}});
 assert.equal(versionManifest(newId).transformIndexHtml()[0].attrs.content,newId);
 assert.equal(emitted[0].fileName,'pocket-version.json');assert.deepEqual(JSON.parse(emitted[0].source),{id:newId,assets:['/assets/a.js','/assets/b.css']});
 const root=mkdtempSync('/tmp/pocket-version-test-');
 try{for(const dir of ['src','public','bin','.local'])mkdirSync(join(root,dir));for(const file of ['src/a.ts','public/icon.svg','index.html','package.json','package-lock.json','vite.config.ts','bin/build-version.mjs'])writeFileSync(join(root,file),'original');
 const a=frontendVersion(root);writeFileSync(join(root,'.local/private.txt'),'must not enter metadata');assert.equal(frontendVersion(root),a);writeFileSync(join(root,'src/a.ts'),'changed');assert.notEqual(frontendVersion(root),a);
 }finally{rmSync(root,{recursive:true,force:true});}
});
