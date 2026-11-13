import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionSyncMotion } from '../src/collectionSyncMotion.ts';
import { createComposerToolsMotion } from '../src/composerToolsMotion.ts';
import { createReadHealth } from '../src/readHealth.ts';

function surface() {
 const media=new EventTarget(),doc=new EventTarget(),browser=new EventTarget(),attributes=new Map(),animations=[];
 media.matches=false;doc.visibilityState='visible';browser.navigator={onLine:true};browser.matchMedia=()=>media;browser.visualViewport=new EventTarget();doc.defaultView=browser;
 const element=Object.assign(new EventTarget(),{ownerDocument:doc,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),animate(frames,options){
  const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;},finish(){this.onfinish?.();}};animations.push(animation);return animation;
 }});
 return{element,media,doc,browser,attributes,animations};
}
const receipt=(serial,outcome='applied')=>({serial,outcome});
const input=(extra={})=>({scope:'machine:scope',pending:false,current:true,completions:[receipt(0,'none')],...extra});

test('transport reachability, source unavailability and abandoned requests do not claim data was applied',()=>{
 const store=createReadHealth(()=>1);store.observe({type:'pending'});store.observe({type:'reachable'});store.observe({type:'settled'});
 assert.deepEqual(store.getCompletionSnapshot(),receipt(0,'cancelled'));
 store.observe({type:'pending'});store.observe({type:'unavailable'});store.observe({type:'settled'});assert.deepEqual(store.getCompletionSnapshot(),receipt(0,'unavailable'));
 store.observe({type:'pending'});store.observe({type:'applied'});store.observe({type:'settled'});assert.deepEqual(store.getCompletionSnapshot(),receipt(1));
 store.reset();assert.deepEqual(store.getCompletionSnapshot(),receipt(0,'none'));
});

test('verified same-source completion fades for 120ms and ordinary rerenders do not restart or cancel its tail',()=>{
 const s=surface(),owner=createCollectionSyncMotion(s.element);owner.observe(input({pending:true}));owner.observe(input({completions:[receipt(1)]}));
 assert.equal(s.animations.length,1);assert.equal(s.animations[0].options.duration,120);assert.equal(s.attributes.has('data-finishing'),true);
 owner.observe(input({completions:[receipt(1)]}));assert.equal(s.animations[0].cancelled,false);
 s.animations[0].finish();assert.equal(s.attributes.has('data-finishing'),false);owner.dispose();
});

test('failure, cancellation, unavailable state, stale content and changed source skip success motion',()=>{
 for(const outcome of ['failed','unavailable','cancelled']){
  const s=surface(),owner=createCollectionSyncMotion(s.element);owner.observe(input({pending:true}));owner.observe(input({completions:[receipt(1,outcome)]}));assert.equal(s.animations.length,0);owner.dispose();
 }
 for(const extra of [{current:false},{scope:'different:scope'}]){
  const s=surface(),owner=createCollectionSyncMotion(s.element);owner.observe(input({pending:true}));owner.observe(input({...extra,completions:[receipt(1)]}));assert.equal(s.animations.length,0);owner.dispose();
 }
});

test('new requests, offline, hidden pages and reduced motion immediately withdraw a finishing line',()=>{
 for(const interruption of ['pending','offline','hidden','reduce']){
  const s=surface(),owner=createCollectionSyncMotion(s.element);owner.observe(input({pending:true}));owner.observe(input({completions:[receipt(1)]}));
  if(interruption==='pending')owner.observe(input({pending:true,completions:[receipt(1)]}));
  if(interruption==='offline'){s.browser.navigator.onLine=false;s.browser.dispatchEvent(new Event('offline'));}
  if(interruption==='hidden'){s.doc.visibilityState='hidden';s.doc.dispatchEvent(new Event('visibilitychange'));}
  if(interruption==='reduce'){s.media.matches=true;s.media.dispatchEvent(new Event('change'));}
  assert.equal(s.animations[0].cancelled,true);assert.equal(s.attributes.has('data-finishing'),false);owner.dispose();
 }
});

test('a completion with no visible pending cycle never invents a progress indicator',()=>{
 const s=surface(),owner=createCollectionSyncMotion(s.element);owner.observe(input({completions:[receipt(2)]}));assert.equal(s.animations.length,0);owner.dispose();
});

test('composer only animates its existing tools on an eligible compact-to-expanded transition',()=>{
 const s=surface(),form=Object.assign(new EventTarget(),{ownerDocument:s.doc,querySelector:()=>s.element});const owner=createComposerToolsMotion(form);
 owner.observe(false,true);assert.equal(s.animations.length,0);owner.observe(true,true);owner.observe(false,true);
 assert.equal(s.animations.length,1);assert.deepEqual(s.animations[0].frames,[{opacity:0,transform:'translateY(3px)'},{opacity:1,transform:'none'}]);assert.equal(s.animations[0].options.duration,120);
 form.dispatchEvent(new Event('beforeinput'));assert.equal(s.animations[0].cancelled,true);owner.dispose();
});

test('composer keyboard, composition, picker and reduced-motion restrictions never move the input or schedule future work',()=>{
 const s=surface(),form=Object.assign(new EventTarget(),{ownerDocument:s.doc,querySelector:()=>s.element});const owner=createComposerToolsMotion(form);
 owner.observe(true,true);owner.observe(false,false);assert.equal(s.animations.length,0);
 owner.observe(true,true);s.media.matches=true;owner.observe(false,true);assert.equal(s.animations.length,0);
 owner.dispose();owner.observe(true,true);owner.observe(false,true);assert.equal(s.animations.length,0);
});

test('a newly resized keyboard or interrupted tool tap cancels the toolbar without touching form geometry',()=>{
 for(const event of ['pointerdown','compositionstart','viewport']){
  const s=surface(),form=Object.assign(new EventTarget(),{ownerDocument:s.doc,querySelector:()=>s.element});const owner=createComposerToolsMotion(form);
  owner.observe(true,true);owner.observe(false,true);assert.equal(s.attributes.has('data-composer-tools-motion'),true);
  if(event==='viewport')s.browser.visualViewport.dispatchEvent(new Event('resize'));else form.dispatchEvent(new Event(event));
  assert.equal(s.animations[0].cancelled,true);assert.equal(s.attributes.has('data-composer-tools-motion'),false);owner.dispose();
 }
});
