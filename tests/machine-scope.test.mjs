import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMachine, currentMachineId, machineApiPath, machineStorageKey, machineTaskUrl, machineNavigationUrl, requireMachine, changeMachine, bindMachineUnloadGuard } from '../src/machineScope.ts';
import { registerReloadGuard, holdReload } from '../src/updateSafety.ts';
import { pocketTaskTarget, pocketTaskUrl, readableCodexMarkdown } from '../src/codexMarkup.ts';
import { readCreationPreference, saveCreationPreference } from '../src/creationPreference.ts';
import { readPocketActivity, savePocketActivity } from '../src/pocketActivity.ts';
import { readCreationRecoveryIds, saveCreationRecoveryIds } from '../src/taskOperations.ts';
import { createQuestionPresentationStore } from '../src/questionPresentation.ts';
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

test('explicit scope wins, old task links stay ged, fresh entry may remember wandou, and unknown scope is invalid',()=>{
 for(const [search,last,result] of [['','wandou','wandou'],['',null,'ged'],['','unknown','ged'],[`?task=${id}`,'wandou','ged'],['?task=','wandou','ged'],['?machine=ged','wandou','ged'],['?machine=wandou',null,'wandou'],['?machine=nope','wandou',null],['?machine=','ged',null],['?machine=ged&machine=wandou','ged',null]])assert.equal(resolveMachine(search,last),result,search);
});
test('API and private preference keys preserve ged compatibility without allowing prefix or path escapes',()=>{
 assert.equal(machineApiPath('/api/catalog','ged'),'/api/catalog');assert.equal(machineApiPath('/api/catalog','wandou'),'/api/machines/wandou/catalog');
 assert.equal(machineApiPath(`/api/tasks/${id}/attachments/${id}?preview=1`,'wandou'),`/api/machines/wandou/tasks/${id}/attachments/${id}?preview=1`);
 for(const key of ['navigator.view','pocket.pending-task','pocket.activity.v1','pocket.creation-location.v1','pocket.ignored-questions.v1','pocket.pending-creation-ids.v1']){assert.equal(machineStorageKey(key,'ged'),key);assert.notEqual(machineStorageKey(key,'wandou'),key)}
 for(const path of ['/api/machines/ged/catalog','/api/../catalog','/api/%2e%2e/catalog','/api/a%2fb/../catalog','/api/a\\b','//evil.test/api/catalog','https://evil.test/api/catalog'])assert.throws(()=>machineApiPath(path,'wandou'));
 for(const fn of [()=>requireMachine(null),()=>machineApiPath('/api/catalog',null),()=>machineStorageKey('x',null),()=>machineTaskUrl(id,null)])assert.throws(fn,/请选择电脑/);
});
test('scoped task links preserve old ged identity and do not route unknown machines',()=>{
 assert.equal(machineTaskUrl(id,'ged'),`/?task=${id}`);assert.equal(machineTaskUrl(id,'wandou'),`/?machine=wandou&task=${id}`);
 assert.deepEqual(pocketTaskTarget(`codex://threads/${id}`,'wandou'),{threadId:id,machine:'wandou'});
 assert.equal(pocketTaskUrl(`/?task=${id}`,'wandou'),`/?machine=ged&task=${id}`);
 assert.equal(pocketTaskUrl(pocketTaskUrl(`/?task=${id}`,'wandou'),'wandou'),`/?machine=ged&task=${id}`);
 for(const url of [`/?machine=oops&task=${id}`,`/?machine=wandou&machine=ged&task=${id}`,`/?task=${id}&extra=1`,`codex://threads/../../escape`])assert.equal(pocketTaskTarget(url,'ged'),null);
 const next=new URL(machineNavigationUrl(`https://pocket.example.com/?machine=ged&task=${id}#old`,'wandou'));assert.equal(next.origin,'https://pocket.example.com');assert.equal(next.search,'?machine=wandou');assert.equal(next.hash,'');
});
test('only actual local Node entrypoints route remote selection through the public Worker',()=>{
 for(const origin of ['https://threads.local','http://localhost:4397','http://127.0.0.1:4397','http://[::1]:4397']) {
  assert.equal(machineNavigationUrl(origin+'/?task='+id,'wandou'),'https://pocket.example.com/?machine=wandou');
  assert.equal(new URL(machineNavigationUrl(origin+'/?machine=wandou','ged')).origin,new URL(origin).origin);
 }
 assert.equal(machineNavigationUrl('https://fixture.example/?task='+id,'wandou'),'https://fixture.example/?machine=wandou');
 assert.equal(machineNavigationUrl('https://pocket.example.com/','wandou',id),'https://pocket.example.com/?machine=wandou&task='+id);
});
test('current machine is fixed for the document and remembered wandou entry gains an explicit URL',()=>{
 const prior=global.window,storage=new Map([['pocket.machine.v1','wandou']]),navigation=[];
 const location={href:'https://pocket.example.com/',search:'',origin:'https://pocket.example.com',assign:url=>navigation.push(url)};
 global.window={location,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},history:{state:null,replaceState(_state,_unused,url){location.href=url;location.search=new URL(url).search}}};
 try{
  assert.equal(currentMachineId(),'wandou');assert.equal(location.search,'?machine=wandou');
  location.href='https://pocket.example.com/?machine=ged';location.search='?machine=ged';assert.equal(currentMachineId(),'wandou');
  const unregister=registerReloadGuard(()=> '还有未完成的输入，请处理后再更新。');
  assert.equal(changeMachine('ged'),'还有未完成的输入，请处理后再切换电脑。');assert.deepEqual(navigation,[]);assert.equal(storage.get('pocket.machine.v1'),'wandou');unregister();
  const release=holdReload('上传尚未完成，请稍后更新。');assert.equal(changeMachine('ged'),'上传尚未完成，请稍后切换电脑。');assert.deepEqual(navigation,[]);release();
  assert.equal(changeMachine('ged'),null);assert.deepEqual(navigation,['https://pocket.example.com/?machine=ged']);assert.equal(storage.get('pocket.machine.v1'),'ged');
  // Existing device-specific producers all use the same scoped key, not just
  // the helper's independently tested key generator.
  const memory=new Map([['pocket.creation-location.v1',JSON.stringify({cwd:'/ged',locationId:'g'})],['pocket.activity.v1',JSON.stringify([[id,{visitedAt:Date.now()}]])],['pocket.pending-creation-ids.v1',JSON.stringify([id])],['pocket.ignored-questions.v1',JSON.stringify({version:1,ignored:[JSON.stringify([id,'q'])]})]]);
  const local={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
  assert.equal(readCreationPreference(local),null);assert.equal(readPocketActivity(local).size,0);assert.deepEqual(readCreationRecoveryIds(local),[]);
  const questions=createQuestionPresentationStore(local);assert.equal(questions.isIgnored(id,'q'),false);questions.setIgnored(id,'q',true);
  saveCreationPreference({cwd:'/wandou',locationId:'w'},local);savePocketActivity(new Map([[id,{visitedAt:Date.now()}]]),local);saveCreationRecoveryIds([id],local);
  assert.equal(readCreationPreference(local).cwd,'/wandou');assert.equal(JSON.parse(memory.get('pocket.creation-location.v1')).cwd,'/ged');
  assert.ok(memory.has(machineStorageKey('pocket.activity.v1','wandou')));assert.ok(memory.has(machineStorageKey('pocket.pending-creation-ids.v1','wandou')));assert.ok(memory.has(machineStorageKey('pocket.ignored-questions.v1','wandou')));
  assert.match(readableCodexMarkdown(`::created-thread{threadId="${id}"}`),/machine=wandou/);
 }finally{global.window=prior}
});
test('beforeunload uses active draft guards and stops blocking once work is safely owned elsewhere',()=>{
 const target=new EventTarget(),cleanup=bindMachineUnloadGuard(target);let pending=true;const unregister=registerReloadGuard(()=>pending?'draft':null);
 const blocked=new Event('beforeunload',{cancelable:true});target.dispatchEvent(blocked);assert.equal(blocked.defaultPrevented,true);
 pending=false;const clear=new Event('beforeunload',{cancelable:true});target.dispatchEvent(clear);assert.equal(clear.defaultPrevented,false);unregister();cleanup();
});
