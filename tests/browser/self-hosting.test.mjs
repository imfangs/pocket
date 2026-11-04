import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness,engines,ids } from './fixture.mjs';
const profile={schemaVersion:1,defaultMachine:'local',machines:[{id:'local',label:'My Mac'}],publicOrigin:null};
for(const engine of engines) test(`${engine}: a generic self-hosted Mac loads, sends and exposes no author machine choice`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{locale:'en-US',clientConfiguration:profile});
  try{
    const page=await h.open(null);
    assert.equal(await page.locator('.workspace-title').textContent(),'All');
    await page.locator('.workspace-header .mobile-only').click();
    await page.locator('.sidebar.mobile-open .sidebar-settings').click();
    const settings=page.locator('dialog.settings-dialog');await settings.waitFor();
    assert.match(await settings.locator('.machine-picker').textContent(),/My Mac/);
    assert.equal(await settings.locator('.machine-picker select').count(),0);
    await page.keyboard.press('Escape');await settings.waitFor({state:'detached'});
    if(await page.locator('.sidebar.mobile-open').count())await page.locator('.sidebar.mobile-open .brand > .icon-button').click();
    await page.locator(`[data-thread-id="${ids.regular}"]`).click();
    await page.locator('.conversation-live').waitFor();
    const input=page.locator('.conversation-composer textarea');await input.fill('A self-hosted message.');
    const send=page.locator('.conversation-composer button[type="submit"]');await send.click();
    const deadline=Date.now()+8000;while(!h.calls.some(call=>call.method==='POST'&&call.action==='messages')){if(Date.now()>deadline)throw new Error('Self-hosted send did not arrive');await new Promise(done=>setTimeout(done,20));}
    const request=h.calls.find(call=>call.method==='POST'&&call.action==='messages');h.accept(ids.regular,request.requestId);
    await page.waitForFunction(id=>document.querySelector(`[data-query-id="${id}"]`)?.getAttribute('data-query-state')==='accepted',request.requestId);
    assert.ok(h.calls.every(call=>!call.machine||call.machine==='local'));
    assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
  }finally{await h.close();}
});
