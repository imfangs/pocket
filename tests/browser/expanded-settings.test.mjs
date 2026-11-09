import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,engines} from './fixture.mjs';

async function lockedPage(h) {
  const page=await h.open(null);
  await page.route(/\/api\/(?:machines\/[^/]+\/)?auth\/status$/,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({authenticated:false})}));
  await page.reload();await page.locator('#passphrase').waitFor();
  return page;
}

for(const engine of engines) test(`${engine}: pointer visibility toggles preserve login input, caret and continued typing`,{timeout:30000},async()=>{
  for(const locale of ['zh-CN','en-US']) {
    const h=await createHarness(engine,{width:320,locale});
    try {
      const page=await lockedPage(h),input=page.locator('#passphrase'),button=page.locator('.passphrase-input button');
      for(const gesture of ['click','tap']) {
        await input.fill('synthetic-passphrase');
        await input.evaluate(node=>{window.visibilityField=node;node.setSelectionRange(5,5);});
        await button[gesture]();
        assert.equal(await input.evaluate(node=>document.activeElement===node&&node===window.visibilityField),true);
        assert.equal(await input.evaluate(node=>node.selectionStart),5);
        await page.keyboard.type('Q');
        assert.equal(await input.inputValue(),'synthQetic-passphrase');
      }
      assert.equal(h.calls.some(call=>call.action==='messages'||call.path.endsWith('/auth/login')),false);
      assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
    }finally{await h.close();}
  }
});

for(const engine of engines) test(`${engine}: keyboard and non-editing visibility activation leave focus with the control`,{timeout:30000},async()=>{
  const h=await createHarness(engine,{width:390,locale:'en-US'});
  try {
    const page=await lockedPage(h),input=page.locator('#passphrase'),button=page.locator('.passphrase-input button');
    await input.fill('synthetic-passphrase');
    await button.focus();await page.keyboard.press('Space');
    assert.equal(await button.evaluate(node=>document.activeElement===node),true);
    assert.equal(await input.getAttribute('type'),'text');
    await page.locator('h1').click();await button.tap();
    assert.equal(await input.evaluate(node=>document.activeElement===node),false);
    assert.equal(await input.inputValue(),'synthetic-passphrase');
    assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
  }finally{await h.close();}
});
