import test,{after} from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,mkdirSync} from 'node:fs';import {resolve,dirname} from 'node:path';
import {createHarness,engines,ids,refresh} from './fixture.mjs';import {runScenario} from './scenario.mjs';
const results=[];after(()=>{const path=resolve(process.env.POCKET_NOTIFICATION_REPORT||'.local/qa/browser-notifications/scenarios.json');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify({scenarios:results},null,2)+'\n');});
const c='a7100000-0000-4000-8000-000000000003';
const notify=(page,id,machine='ged')=>page.evaluate(({id,machine})=>{
 const channel=new MessageChannel();window.notificationAcks=[];channel.port1.onmessage=e=>window.notificationAcks.push(e.data);
 navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:machine==='ged'?'pocket-open-task':'pocket-open-machine-task',threadId:id,machineId:machine},ports:[channel.port2]}));
},{id,machine});
const catalog=(h,extra=[])=>({threads:[h.metadata(ids.regular),h.metadata(ids.empty),...extra],groups:[],projects:[{id:'fixture',name:'合成项目',paths:['/synthetic'],order:0,separator:false}],sourceInfo:{syncedAt:Date.now(),scope:'synthetic',pocketRead:{available:true,scope:'smoke-ged'}},sourceError:null,csrfToken:'synthetic-token'});
const routeUnknown=async(page,h)=>{
 const template={...h.metadata(ids.empty),id:c,title:'Synthetic notification target',pocketContent:{known:true,scope:'smoke-ged',revision:1,version:'1'.repeat(64),messageId:'unknown-u'}};
 await page.route(/\/api\/(?:machines\/ged\/)?tasks\/a7100000-0000-4000-8000-000000000003\/(?:history|transcript|attachments|connection)$/,async r=>{
  const action=new URL(r.request().url()).pathname.split('/').at(-1);let data=action==='attachments'?{attachments:[]}:action==='connection'?{status:'connected',checkedAt:Date.now()}:{source:action==='history'?'desktop':'rollout',resumeState:'resumed',runtime:'idle',canSend:action==='history',canQueue:true,canAttemptSend:true,messages:[],outbox:[],pendingRequests:[],asyncQuestions:[],checkedAt:Date.now(),pocketContent:template.pocketContent};
  await r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(data)});
 });return template;
};
const flow=(engine,name,run,width=390)=>test(`${engine}: ${name}`,{timeout:30000},()=>runScenario({engine,name,create:()=>createHarness(engine,{width}),run,record:r=>results.push(r)}));
for(const engine of engines){
 flow(engine,'notification enters a known conversation before slow sync and keeps another conversation draft',async h=>{
  const page=await h.open();const input=page.locator('.conversation-composer textarea');await input.fill('Keep this unsent notification draft.');await input.blur();
  await page.locator('[data-inspector-close]').click();await page.locator('.inspector').waitFor({state:'detached'});
  const gate=h.pause('sync',{repeat:true});await notify(page,ids.empty);await page.locator('.inspector-title-trigger').filter({hasText:'合成空会话'}).waitFor();
  assert.equal(await page.evaluate(()=>window.notificationAcks.includes('pocket-task-received')),true);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
  await notify(page,ids.regular);await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();
  assert.equal(await page.locator('.conversation-composer textarea').inputValue(),'Keep this unsent notification draft.');gate.release();
  assert.ok(h.calls.filter(x=>x.method!=='GET').every(x=>x.path==='/api/sync'));
 });
 flow(engine,'notification unknown target survives a failed sync and enters on quiet foreground recovery',async h=>{
  const page=await h.open(null),unknown=await routeUnknown(page,h);let fail=true;
  await page.route('**/api/sync',r=>r.fulfill({status:fail?503:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(fail?{error:'Synthetic notification sync failed'}:catalog(h,[unknown]))}));
  await notify(page,c);await page.locator('[data-collection-feedback="waiting"]').waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),c);
  assert.equal(await page.evaluate(()=>window.notificationAcks.includes('pocket-task-received')),true);
  assert.equal(await page.locator('.collection-feedback-retry').count(),0);
  fail=false;await refresh(page);await page.locator('.inspector-title-trigger').filter({hasText:unknown.title}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
 });
 flow(engine,'later user selection wins over a delayed notification catalog',async h=>{
  const page=await h.open(null),unknown=await routeUnknown(page,h);let release;const pending=new Promise(resolve=>release=resolve);
  await page.route('**/api/sync',async r=>{await pending;await r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog(h,[unknown]))});});
  await notify(page,c);await page.locator(`.task-select[data-thread-id="${ids.regular}"]`).click();await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();release();
  await page.waitForTimeout(180);assert.ok((await page.locator('.inspector-title-trigger').textContent()).includes('合成已有会话'));
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
 });
 flow(engine,'notification for another machine does not replace the current conversation or draft',async h=>{
  const page=await h.open(),input=page.locator('.conversation-composer textarea');await input.fill('Keep this local-machine draft.');await notify(page,ids.empty,'wandou');await page.waitForTimeout(100);
  assert.ok((await page.locator('.inspector-title-trigger').textContent()).includes('合成已有会话'));
  assert.equal(await input.inputValue(),'Keep this local-machine draft.');assert.equal(await page.evaluate(()=>window.notificationAcks.length),0);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
 });
 flow(engine,'known notification route survives background auth expiry and reauthentication',async h=>{
  const page=await h.open();let authenticated=true;let blockSync=true;
  await page.route('**/api/auth/status',r=>r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated})}));
  await page.route('**/api/auth/login',r=>{authenticated=true;return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated:true})});});
  await page.route('**/api/sync',r=>{if(blockSync){authenticated=false;return r.fulfill({status:401,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:'{"error":"expired"}'});}return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog(h))});});
  await notify(page,ids.empty);await page.locator('.access-screen #passphrase').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.empty);
  blockSync=false;await page.locator('#passphrase').fill('Synthetic notification login only');await page.getByRole('button',{name:'进入 Pocket',exact:true}).click();
  await page.locator('.inspector-title-trigger').filter({hasText:'合成空会话'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.empty);
 });
 flow(engine,'a notification received on the login screen is retained through StrictMode mounting',async h=>{
  const page=await h.open();let authenticated=false;
  await page.route('**/api/auth/status',r=>r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated})}));
  await page.route('**/api/auth/login',r=>{authenticated=true;return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated:true})});});
  await page.reload();await page.locator('.access-screen #passphrase').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
  await notify(page,ids.empty);await page.waitForFunction(()=>window.notificationAcks.includes('pocket-task-received'));
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),ids.empty);
  await page.locator('#passphrase').fill('Synthetic notification login only');await page.getByRole('button',{name:'进入 Pocket',exact:true}).click();
  await page.locator('.inspector-title-trigger').filter({hasText:'合成空会话'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.empty);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
 });
 flow(engine,'a later explicit selection replaces a notification-owned route',async h=>{
  const page=await h.open(null);await notify(page,ids.empty);await page.locator('.inspector-title-trigger').filter({hasText:'合成空会话'}).waitFor();
  await page.locator('[data-inspector-close]').click();await page.locator('.inspector').waitFor({state:'detached'});
  assert.equal(new URL(page.url()).searchParams.get('task'),null);
  await page.locator(`.task-select[data-thread-id="${ids.regular}"]`).click();await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
 });

 flow(engine,'a newer desktop selection survives reauthentication instead of reopening the notification target',async h=>{
  const page=await h.open(null);let authenticated=true;
  await page.route('**/api/auth/status',r=>r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated})}));
  await page.route('**/api/auth/login',r=>{authenticated=true;return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated:true})});});
  await notify(page,ids.empty);await page.locator('.inspector-title-trigger').filter({hasText:'合成空会话'}).waitFor();
  await page.locator(`.task-select[data-thread-id="${ids.regular}"]`).click();await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
  authenticated=false;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('navigator-auth-expired',{detail:{machine:'ged'}})));
  await page.locator('.access-screen #passphrase').waitFor();await page.locator('#passphrase').fill('Synthetic notification login only');await page.getByRole('button',{name:'进入 Pocket',exact:true}).click();
  await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
 },1280);

 flow(engine,'unknown notification remains durable through blocked storage and background401 login',async h=>{
  const page=await h.open(null),unknown=await routeUnknown(page,h);let authenticated=true,fail=true;
  await page.route('**/api/auth/status',r=>r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated})}));
  await page.route('**/api/auth/login',r=>{authenticated=true;fail=false;return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated:true})});});
  await page.route('**/api/sync',r=>{if(fail){authenticated=false;return r.fulfill({status:401,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:'{"error":"expired"}'});}return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog(h,[unknown]))});});
  await page.evaluate(()=>Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}}}));
  await notify(page,c);await page.locator('.access-screen #passphrase').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'),c);assert.equal(await page.evaluate(()=>window.notificationAcks.includes('pocket-task-received')),true);
  await page.locator('#passphrase').fill('Synthetic notification login only');await page.getByRole('button',{name:'进入 Pocket',exact:true}).click();
  await page.locator('.inspector-title-trigger').filter({hasText:unknown.title}).waitFor();assert.equal(new URL(page.url()).searchParams.get('task'),c);
 });

 flow(engine,'explicitly choosing the same desktop row revokes a delayed notification route before sync or login',async h=>{
  const page=await h.open(),unknown=await routeUnknown(page,h);let authenticated=true,release;
  const pending=new Promise(resolve=>release=resolve);
  await page.route('**/api/auth/status',r=>r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated})}));
  await page.route('**/api/auth/login',r=>{authenticated=true;return r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify({authenticated:true})});});
  await page.route('**/api/sync',async r=>{await pending;await r.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog(h,[unknown]))});});
  await notify(page,c);assert.equal(new URL(page.url()).searchParams.get('task'),c);
  await page.locator(`.task-select[data-thread-id="${ids.regular}"]`).click();
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('pocket.pending-task')),null);
  release();await page.waitForTimeout(180);
  assert.ok((await page.locator('.inspector-title-trigger').textContent()).includes('合成已有会话'));
  assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
  authenticated=false;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('navigator-auth-expired',{detail:{machine:'ged'}})));
  await page.locator('.access-screen #passphrase').waitFor();await page.locator('#passphrase').fill('Synthetic notification login only');await page.getByRole('button',{name:'进入 Pocket',exact:true}).click();
  await page.locator('.inspector-title-trigger').filter({hasText:'合成已有会话'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('task'),ids.regular);
 },1280);

}
