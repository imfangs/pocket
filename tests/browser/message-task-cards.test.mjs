import test from 'node:test';import assert from 'node:assert/strict';
import {createHarness,engines,ids,refresh} from './fixture.mjs';
const directive=id=>`::created-thread{threadId="${id}"}`;
const rowId='task-card-answer';
for(const engine of engines)for(const width of [320,390]){
 test(`${engine}: ${width}px created conversation cards show metadata, stay stable and navigate without losing drafts`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{width,locale:width===320?'en-US':'zh-CN'});try{
   const ordinary=`[ordinary](codex://threads/${ids.empty})`;
   h.patchHistory(ids.regular,{messages:[{id:rowId,role:'assistant',phase:'final',text:`Created two conversations.\n\n${directive(ids.empty)}\n${directive(ids.regular)}\n\n${ordinary}`,turnId:'initial',timestamp:Date.now()}]});
   const page=await h.open(),row=page.locator(`[data-message-id="${rowId}"]`),cards=row.locator('.message-task-card');
   await cards.first().waitFor();assert.equal(await cards.count(),2);assert.equal(await row.locator('.pocket-task-link').count(),1);
   await cards.first().getByText('ged 合成空会话',{exact:true}).waitFor();assert.match(await cards.first().textContent(),/合成项目/);
   assert.equal(h.calls.filter(c=>c.threadId===ids.empty).length,0,'Rendering the card never reads or opens its target');
   const sizes=await cards.evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,height:b.height,width:b.width};}));
   for(const b of sizes)assert.ok(b.height>=80&&b.left>=-1&&b.right<=width+1&&b.width>200,JSON.stringify(b));
   await row.evaluate(node=>{window.taskArticle=node;window.taskCard=node.querySelector('.message-task-card');});
   const catalog={threads:[h.metadata(ids.regular),{...h.metadata(ids.empty),title:'Renamed target with <script> plain text'}],groups:[],projects:[{id:'fixture',name:'合成项目',paths:['/synthetic'],order:0,separator:false}],sourceInfo:{syncedAt:Date.now(),scope:'synthetic',pocketRead:{available:true,scope:'smoke-ged'}},sourceError:null,csrfToken:'synthetic-token'};
   await page.route(/\/api\/(?:machines\/ged\/)?(?:catalog|sync)(?:\?|$)/,route=>route.fulfill({status:200,contentType:'application/json',headers:{'X-Pocket-Machine':'ged'},body:JSON.stringify(catalog)}));
   await refresh(page);await cards.first().getByText(catalog.threads[1].title,{exact:true}).waitFor();
   assert.equal(await row.evaluate(n=>n===window.taskArticle&&n.querySelector('.message-task-card')===window.taskCard),true);assert.equal(await cards.locator('script').count(),0);
   const input=page.locator('.conversation-composer textarea');await input.fill('Preserve the ordinary unsent draft.');
   await cards.first().evaluate(node=>{window.addEventListener('click',event=>{window.modifierPrevented=event.defaultPrevented;event.preventDefault();},{once:true});node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}));});
   assert.equal(await page.evaluate(()=>modifierPrevented),false);assert.equal(await page.locator('.conversation-composer textarea').inputValue(),'Preserve the ordinary unsent draft.');
   await cards.first().focus();await page.keyboard.press('Enter');await page.locator('.inspector-title-trigger').filter({hasText:catalog.threads[1].title}).waitFor();
   assert.equal(await page.locator('.conversation-composer textarea').inputValue(),'');
   await page.evaluate(id=>window.dispatchEvent(new CustomEvent('pocket-open-task',{detail:id})),ids.regular);
   await page.locator('.conversation-composer textarea').waitFor();
   await page.waitForFunction(()=>document.querySelector('.conversation-composer textarea')?.value==='Preserve the ordinary unsent draft.');
   assert.ok(h.calls.filter(c=>c.method!=='GET').every(c=>c.path==='/api/sync'));assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
  }finally{await h.close();}
 });
 test(`${engine}: ${width}px user examples and assistant code/quotes stay plain while missing task details remain usable`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{width});try{
   const unknown='a7300000-0000-4000-8000-000000000009';
   h.patchHistory(ids.regular,{messages:[{id:'user-example',role:'user',text:directive(ids.empty),turnId:'initial',timestamp:Date.now()},
    {id:'assistant-example',role:'assistant',phase:'final',text:`> ${directive(ids.empty)}\n\n\`${directive(ids.empty)}\``,turnId:'initial',timestamp:Date.now()},
    {id:'missing-task',role:'assistant',phase:'final',text:directive(unknown),turnId:'initial',timestamp:Date.now()}]});
   const page=await h.open();await page.locator('[data-message-id="missing-task"] .message-task-card').waitFor();
   assert.equal(await page.locator('[data-message-id="user-example"] .message-task-card,[data-message-id="assistant-example"] .message-task-card').count(),0);
   const card=page.locator('[data-message-id="missing-task"] .message-task-card');assert.match(await card.textContent(),/会话详情暂未同步/);assert.match(await card.getAttribute('href'),new RegExp(unknown));
   assert.equal(h.calls.filter(c=>c.threadId===unknown).length,0);assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
  }finally{await h.close();}
 });
}
