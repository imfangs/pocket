import test from 'node:test';import assert from 'node:assert/strict';
import {createHarness,engines,ids,refresh} from './fixture.mjs';
const third='a7400000-0000-4000-8000-000000000003';
const ref=id=>`::created-thread{threadId="${id}"}`;
const message=(id,text)=>({id,role:'assistant',phase:'final',text,turnId:'initial',timestamp:Date.now()+10});
const current=(page,title)=>page.locator('.inspector-title-trigger').filter({hasText:title}).waitFor();
async function installDirectory(page,h,rows,scope='smoke-ged'){
 const catalog={threads:rows,groups:[],projects:[{id:'fixture',name:'Project',paths:['/synthetic'],order:0,separator:false}],sourceInfo:{syncedAt:Date.now(),scope:'synthetic',pocketRead:{available:true,scope}},sourceError:null,csrfToken:'synthetic-token'};
 await page.route(/\/api\/(?:machines\/ged\/)?(?:catalog|sync)(?:\?|$)/,route=>route.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog)}));
 await page.route(new RegExp('/api/(?:machines/ged/)?tasks/'+third+'/'),async route=>{
  const path=new URL(route.request().url()).pathname,action=path.split('/').at(-1);
  const body=action==='attachments'?{attachments:[]}:action==='connection'?{status:'connected',checkedAt:Date.now()}:{source:action==='history'?'desktop':'rollout',resumeState:'resumed',runtime:'idle',canSend:action==='history',canQueue:true,canAttemptSend:true,messages:[message('third-answer','Third conversation body.')],outbox:[],pendingRequests:[],asyncQuestions:[],checkedAt:Date.now(),hasMore:false,pocketContent:rows.find(x=>x.id===third)?.pocketContent};
  await route.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(body)});
 });
 return catalog;
}
async function swipeBack(page){
 await page.locator('.inspector').evaluate(async panel=>{
  const root=panel.querySelector('.conversation-messages'),box=root.getBoundingClientRect(),y=box.top+Math.min(70,box.height/2);
  for(const [type,x]of [['touchstart',24],['touchmove',170],['touchend',Math.min(innerWidth-10,300)]]){
   const touch={identifier:1,target:root,clientX:x,clientY:y},event=new Event(type,{bubbles:true,cancelable:true});
   Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[touch]},changedTouches:{value:[touch]}});root.dispatchEvent(event);await new Promise(r=>setTimeout(r,40));
  }
 });
}
const noWrites=h=>{assert.ok(h.calls.filter(c=>c.method!=='GET').every(c=>c.path==='/api/sync'));assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);};
for(const engine of engines){
 test(`${engine}: references build A B C back to B A then list, keeping drafts and reading offsets`,{timeout:30000},async()=>{
  const h=await createHarness(engine);try{
   h.patchHistory(ids.regular,{messages:[message('a-card',ref(ids.empty)+'\n\n'+('Earlier reading content.\n\n'.repeat(45)))]});
   h.patchHistory(ids.empty,{messages:[message('b-card',ref(third)+'\n\n'+('Second reading content.\n\n'.repeat(45)))]});
   const page=await h.open();const c={...h.metadata(ids.empty),id:third,title:'Third conversation',pocketContent:{...h.metadata(ids.empty).pocketContent,messageId:'third-answer'}};
   await installDirectory(page,h,[h.metadata(ids.regular),h.metadata(ids.empty),c]);await refresh(page);
   const input=()=>page.locator('.conversation-composer textarea'),reader=()=>page.locator('.conversation-messages');
   await input().fill('Draft A remains saved.');await input().blur();await reader().evaluate(n=>n.scrollTop=0);await page.waitForTimeout(70);
   const posA=await reader().evaluate(n=>n.scrollTop);await page.locator('.message-task-card').click();await current(page,'合成空会话');
   await input().fill('Draft B remains saved.');await input().blur();await reader().evaluate(n=>n.scrollTop=0);await page.waitForTimeout(70);
   const posB=await reader().evaluate(n=>n.scrollTop);await page.locator('.message-task-card').click();await current(page,'Third conversation');
   await swipeBack(page);await current(page,'合成空会话');assert.equal(await input().inputValue(),'Draft B remains saved.');assert.ok(Math.abs(await reader().evaluate(n=>n.scrollTop)-posB)<=2);
   await page.locator('[data-inspector-close]').click();await current(page,'合成已有会话');assert.equal(await input().inputValue(),'Draft A remains saved.');assert.ok(Math.abs(await reader().evaluate(n=>n.scrollTop)-posA)<=2);
   await swipeBack(page);await page.locator('.inspector').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>new URL(location.href).searchParams.get('task')),null);noWrites(h);
  }finally{await h.close();}
 });
 test(`${engine}: same-thread reference does not add a level and notification replaces the reference chain`,{timeout:30000},async()=>{
  const h=await createHarness(engine);try{
   h.patchHistory(ids.regular,{messages:[message('links',ref(ids.regular)+'\n'+ref(ids.empty))]});const page=await h.open();
   await page.locator('.message-task-card').first().click();await current(page,'合成已有会话');await page.locator('.message-task-card').last().click();await current(page,'合成空会话');
   await page.evaluate(id=>window.dispatchEvent(new CustomEvent('pocket-open-task',{detail:id})),ids.regular);await current(page,'合成已有会话');
   await page.locator('[data-inspector-close]').click();await page.locator('.inspector').waitFor({state:'detached'});noWrites(h);
  }finally{await h.close();}
 });
 test(`${engine}: late unknown references are cancelled by a newer selection or a changed source owner`,{timeout:30000},async()=>{
  const h=await createHarness(engine);try{
   h.patchHistory(ids.regular,{messages:[message('unknown',ref(third))]});const page=await h.open();
   await page.route('**/api/sync',route=>route.fulfill({status:503,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:'{"error":"Synthetic weak connection"}'}));
   await page.locator('.message-task-card').click();await page.waitForTimeout(120);await current(page,'合成已有会话');
   await page.evaluate(id=>window.dispatchEvent(new CustomEvent('pocket-open-task',{detail:id})),ids.empty);await current(page,'合成空会话');
   const c={...h.metadata(ids.empty),id:third,title:'Late third',pocketContent:{...h.metadata(ids.empty).pocketContent,messageId:'third-answer'}};
   await installDirectory(page,h,[h.metadata(ids.regular),h.metadata(ids.empty),c]);await refresh(page);await page.waitForTimeout(160);await current(page,'合成空会话');
   await page.locator('[data-inspector-close]').click();await page.locator('.inspector').waitFor({state:'detached'});
   await page.locator(`[data-thread-id="${ids.regular}"]`).click();await current(page,'合成已有会话');
   await installDirectory(page,h,[h.metadata(ids.regular),h.metadata(ids.empty)]);await refresh(page);await page.waitForTimeout(120);
   await page.locator('.message-task-card').click();
   await page.evaluate(()=>{const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(this===sessionStorage&&key.includes('pending-task'))throw new Error('Synthetic blocked session removal');return remove.call(this,key);};});
   await installDirectory(page,h,[h.metadata(ids.regular),h.metadata(ids.empty),c],'new-source');await refresh(page);await page.waitForTimeout(180);await current(page,'合成已有会话');
   assert.equal(await page.evaluate(()=>new URL(location.href).searchParams.get('task')),ids.regular);noWrites(h);
  }finally{await h.close();}
 });
 test(`${engine}: unavailable ancestors are skipped without entering a missing detail`,{timeout:30000},async()=>{
  const h=await createHarness(engine);try{
   h.patchHistory(ids.regular,{messages:[message('link',ref(ids.empty))]});const page=await h.open();await page.locator('.message-task-card').click();await current(page,'合成空会话');
   await installDirectory(page,h,[{...h.metadata(ids.regular),missing:true},h.metadata(ids.empty)]);await refresh(page);await page.waitForTimeout(100);
   await page.locator('[data-inspector-close]').click();await page.locator('.inspector').waitFor({state:'detached'});noWrites(h);
  }finally{await h.close();}
 });
 test(`${engine}: readable archived parents remain in the return chain`,{timeout:30000},async()=>{
  const h=await createHarness(engine);try{
   h.patchHistory(ids.regular,{messages:[message('archived-parent-link',ref(ids.empty))]});const page=await h.open();
   await page.locator('.message-task-card').click();await current(page,'合成空会话');
   await installDirectory(page,h,[{...h.metadata(ids.regular),archived:true},h.metadata(ids.empty)]);await refresh(page);await page.waitForTimeout(100);
   await page.locator('[data-inspector-close]').click();await current(page,'合成已有会话');noWrites(h);
  }finally{await h.close();}
 });

}
