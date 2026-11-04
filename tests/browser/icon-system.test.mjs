import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,engines} from './fixture.mjs';

const verifyIcons=async(page)=>{
  const icons=await page.locator('svg[data-pocket-icon]').evaluateAll(nodes=>nodes.filter(node=>{
    const r=node.getBoundingClientRect();return r.width>0 && r.height>0 && !node.closest('[hidden],[inert]') && r.right>0 && r.left<innerWidth;
  }).map(node=>{const r=node.getBoundingClientRect();return{kind:node.dataset.pocketIcon,width:r.width,height:r.height,stroke:parseFloat(getComputedStyle(node).strokeWidth),className:node.getAttribute('class')};}));
  assert.ok(icons.length);
  for(const icon of icons){
    const sizes={auxiliary:16,action:18,navigation:20,marker:icon.className.includes('lucide-square')?11:13};
    if(icon.kind==='illustration')continue;
    assert.equal(icon.width,sizes[icon.kind],JSON.stringify(icon));assert.equal(icon.height,sizes[icon.kind],JSON.stringify(icon));
    assert.equal(icon.stroke,icon.kind==='marker'?icon.className.includes('lucide-square')?0:2:1.75,JSON.stringify(icon));
  }
};

for(const engine of engines)test(`${engine}: shared icons preserve geometry, native checks and protected input space in both languages`,{timeout:30000},async()=>{
  for(const locale of ['zh-CN','en-US']){
    const h=await createHarness(engine,{width:320,locale,visibility:true});
    try{
      const page=await h.open(null);await verifyIcons(page);
      await page.locator('.thread-sort-trigger').click();await page.locator('.thread-sort-menu').waitFor();
      assert.equal(await page.locator('.rt-DropdownMenuItemIndicator svg[data-pocket-icon]').count(),0);
      await page.keyboard.press('Escape');await page.locator('.thread-sort-menu').waitFor({state:'detached'});
      await page.locator('.new-conversation-button').click();const dialog=page.locator('dialog.new-conversation-dialog');await dialog.waitFor();
      const input=dialog.locator('#quick-create-query');await input.fill('Keep the input clear of the button.');await verifyIcons(page);
      const geometry=await input.evaluate(node=>{
        const box=node.getBoundingClientRect(),button=node.parentElement.querySelector('.quick-create-clear'),b=button.getBoundingClientRect();
        return {contentRight:box.right-parseFloat(getComputedStyle(node).paddingRight),buttonLeft:b.left,buttonWidth:b.width,buttonHeight:b.height};
      });
      assert.ok(geometry.buttonLeft>=geometry.contentRight+4,JSON.stringify(geometry));assert.ok(geometry.buttonWidth>=44&&geometry.buttonHeight>=44);
      await input.fill('');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
      await page.locator('.workspace-header .mobile-only').click();
      await page.waitForFunction(()=>document.querySelector('.sidebar.mobile-open svg[data-pocket-icon]')?.getBoundingClientRect().right>0);
      await verifyIcons(page);
      await page.locator('.sidebar.mobile-open .sidebar-settings').click();const settings=page.locator('dialog.settings-dialog');await settings.waitFor();await verifyIcons(page);
      const theme=await settings.locator('.theme-switch').evaluate(node=>{const r=node.getBoundingClientRect();return{width:r.width,scroll:node.scrollWidth};});
      assert.ok(theme.scroll<=theme.width+1,JSON.stringify(theme));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(h.errors,[]);assert.deepEqual(h.unexpected,[]);
    }finally{await h.close();}
  }
});
