import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines } from './fixture.mjs';
const setup = async (h, mode) => {
 await h.addInitScript(mode => {
  localStorage.setItem('pocket.feedback-shake-v1','on');
  window.motionRequests=0;window.motionHandlers=new Set();
  const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);
  window.addEventListener=(type,fn,...args)=>{if(type==='devicemotion')window.motionHandlers.add(fn);return add(type,fn,...args);};
  window.removeEventListener=(type,fn,...args)=>{if(type==='devicemotion')window.motionHandlers.delete(fn);return remove(type,fn,...args);};
  Object.defineProperty(window,'DeviceMotionEvent',{configurable:true,value:mode==='unsupported'?undefined:{requestPermission:()=>{window.motionRequests++;return mode==='pending'?new Promise(resolve=>{window.resolveMotionPermission=resolve;}):Promise.resolve(mode);}}});
 },mode);
};
const openSettings=async page=>{await page.locator('.workspace-header .mobile-only').click();await page.locator('.sidebar.mobile-open .sidebar-settings').click();await page.locator('.pocket-feedback-settings').waitFor();};
const toggle=page=>page.locator('.pocket-feedback-settings button[role=switch]');
const restore=page=>page.locator('.shake-permission-retry');
const noWrites=h=>{assert.ok(h.calls.filter(c=>c.method!=='GET').every(c=>c.path==='/api/sync'));assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);};
for(const engine of engines){
 test(`${engine}: remembered shaking needs page evidence or an explicit restoration gesture, never mount permission`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{feedbackEnabled:true});try{
   await setup(h,'granted');const page=await h.open(null);await openSettings(page);
   assert.equal(await toggle(page).getAttribute('aria-checked'),'true');await restore(page).waitFor();assert.equal(await page.evaluate(()=>motionRequests),0);
   await page.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await page.evaluate(()=>motionRequests),0);
   await page.reload();await page.locator('[data-thread-id]').first().waitFor();await openSettings(page);assert.equal(await page.evaluate(()=>motionRequests),0);
   await restore(page).click();await restore(page).waitFor({state:'detached'});assert.equal(await page.evaluate(()=>motionRequests),1);
   await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await restore(page).waitFor();assert.equal(await page.evaluate(()=>motionRequests),1);
   // Plain shaped objects exercise the observer logic; they do not emulate OS permission.
   await page.evaluate(()=>{for(const fn of [...motionHandlers])fn({isTrusted:false,acceleration:{x:0,y:0,z:0}});});assert.equal(await restore(page).count(),1);
   await page.evaluate(()=>{for(const fn of [...motionHandlers])fn({isTrusted:true,acceleration:null,accelerationIncludingGravity:{x:0,y:0,z:9.8}});});await restore(page).waitFor({state:'detached'});
   assert.equal(await page.evaluate(()=>motionRequests),1);assert.equal(await page.locator('dialog.feedback-dialog').count(),0);noWrites(h);
  }finally{await h.close();}
 });
 for(const mode of ['denied','unsupported'])test(`${engine}: ${mode} motion access retains feedback and does not claim readiness`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{feedbackEnabled:true,locale:'en-US'});try{
   await setup(h,mode);const page=await h.open(null);await openSettings(page);await restore(page).click();
   await page.getByText(mode==='denied'?'Motion permission was not granted. Use the feedback button instead.':'This browser does not support shaking. Use the feedback button instead.',{exact:true}).waitFor();
   assert.equal(await toggle(page).getAttribute('aria-checked'),'true');assert.equal(await page.evaluate(()=>motionRequests),mode==='denied'?1:0);
   assert.equal(await page.locator('dialog.settings-dialog').getByRole('button',{name:'Report an issue',exact:true}).isEnabled(),true);
   assert.equal(await restore(page).isEnabled(),true);noWrites(h);
  }finally{await h.close();}
 });
 test(`${engine}: closing the preference revokes a delayed grant and Other settings start collapsed`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{feedbackEnabled:true,width:320});try{
   await setup(h,'pending');const page=await h.open(null);await openSettings(page);
   const other=page.locator('.settings-other-disclosure');assert.equal(await other.getAttribute('open'),null);assert.equal(await other.locator('select').isVisible(),false);
   await other.locator('summary').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.settings-other-disclosure').open);
   assert.equal(await other.locator('select').inputValue(),'128');assert.equal(await other.locator('button[role=switch]').getAttribute('aria-checked'),'true');
   await other.locator('summary').click();await page.waitForFunction(()=>!document.querySelector('.settings-other-disclosure').open);
   await restore(page).click();assert.equal(await page.evaluate(()=>motionRequests),1);assert.equal(await restore(page).isDisabled(),true);
   await toggle(page).click();await page.evaluate(()=>resolveMotionPermission('granted'));await page.waitForTimeout(80);
   assert.equal(await toggle(page).getAttribute('aria-checked'),'false');assert.equal(await page.evaluate(()=>localStorage.getItem('pocket.feedback-shake-v1')),null);
   assert.equal(await restore(page).count(),0);assert.equal(await page.locator('dialog.feedback-dialog').count(),0);noWrites(h);
  }finally{await h.close();}
 });
}
