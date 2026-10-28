import test from 'node:test';
import assert from 'node:assert/strict';
import { bindInspectorMotion } from '../src/inspectorMotion.ts';

class Target extends EventTarget {
  listeners=[];
  addEventListener(type,callback,options){super.addEventListener(type,callback,options);this.listeners.push({type,callback,capture:options===true||!!options?.capture});}
  removeEventListener(type,callback,options){super.removeEventListener(type,callback,options);const capture=options===true||!!options?.capture;this.listeners=this.listeners.filter(item=>item.type!==type||item.callback!==callback||item.capture!==capture);}
  fire(type, fields={}){const event=new Event(type,{cancelable:true});for(const [key,value] of Object.entries(fields))Object.defineProperty(event,key,{value});this.dispatchEvent(event);return event;}
}
class Node extends Target {
  attrs=new Map();children=[];styleValues=new Map();calls=[];clientWidth=390;scrollWidth=390;parentElement=null;
  style={setProperty:(key,value)=>this.styleValues.set(key,value),removeProperty:key=>{this.styleValues.delete(key);if(key==='transform')delete this.style.transform;}};
  setAttribute(key,value){this.attrs.set(key,value);}
  removeAttribute(key){this.attrs.delete(key);}
  hasAttribute(key){return this.attrs.has(key);}
  append(node){this.children.push(node);node.parentElement=this;}
  remove(){this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
  closest(){return null;}
  matches(){return false;}
  contains(node){return this.children.includes(node);}
  getBoundingClientRect(){return {left:0,width:390};}
  animate(frames,options){
    const animation=new Target();animation.cancelled=false;
    animation.cancel=()=>{animation.cancelled=true;animation.fire('cancel');};
    this.visualX=Number(frames[0].transform.match(/translate3d\(([^p]+)/)[1]);
    animation.finish=()=>{this.visualX=Number(frames[1].transform.match(/translate3d\(([^p]+)/)[1]);animation.fire('finish');};
    this.calls.push({frames,options,animation});return animation;
  }
}
function fixture({entry=false,reduced=false,desktop=false,animate=true}={}){
  const panel=new Node(),workspace=new Node(),browser=new Target(),document=new Target(),body=new Node(),narrow=new Target(),media=new Target();
  let closes=0,allowed=true,selection=false;
  panel.closest=selector=>selector==='.workspace'?workspace:null;
  document.body=body;document.documentElement=body;document.visibilityState='visible';document.activeElement=null;document.defaultView=browser;
  document.createElement=()=>new Node();document.createEvent=()=>{const event=new Event('pocket-reading-visibility-change');event.initEvent=()=>{};return event;};
  narrow.matches=!desktop;media.matches=reduced;
  Object.assign(browser,{document,innerWidth:390,matchMedia:query=>query.includes('max-width')?narrow:media,getSelection:()=>({isCollapsed:!selection}),
    getComputedStyle:node=>({transform:`matrix(1, 0, 0, 1, ${node.visualX??0}, 0)`,overflowX:node.overflowX??'visible'})});
  if(!animate)panel.animate=undefined;
  const control=bindInspectorMotion(panel,{animateEntry:entry,onClose:()=>closes++,enabled:()=>allowed},browser);
  const target=new Node();target.parentElement=panel;
  const touch=(type,x,y,time,{fingers=type==='touchend'?0:1,at=target,id=1,cancelable=true}={})=>{
    const event=new Event(type,{cancelable});const point={identifier:id,clientX:x,clientY:y};
    Object.defineProperties(event,{target:{value:at},touches:{value:Array.from({length:fingers},()=>point)},changedTouches:{value:[point]},timeStamp:{value:time}});
    panel.dispatchEvent(event);return event;
  };
  return {panel,workspace,browser,document,body,narrow,media,control,touch,target,closes:()=>closes,holdCount:()=>body.children.length,
    allow:value=>{allowed=value;},select:value=>{selection=value;},phase:()=>panel.attrs.get('data-inspector-motion'),finish:()=>panel.calls.at(-1)?.animation.finish()};
}

function focusEditor(f, selected = false) {
  const input = new Node(); input.value = 'Retained draft'; input.selectionStart = 4; input.selectionEnd = selected ? 8 : 4;
  input.matches = selector => /input|textarea|contenteditable/.test(selector);
  input.closest = selector => /input|textarea|contenteditable/.test(selector) ? input : null;
  let blurs = 0;
  input.blur = () => { blurs++; f.document.activeElement = null; f.panel.removeAttribute('data-keyboard-open'); };
  f.panel.children.push(input); f.document.activeElement = input; f.panel.setAttribute('data-keyboard-open', '');
  return { input, blurs: () => blurs };
}

test('a completed message edge swipe returns while the keyboard is open, without transforming the editor', () => {
  const f = fixture(), editor = focusEditor(f);
  f.touch('touchstart', 20, 200, 0);
  assert.equal(f.touch('touchmove', 160, 201, 100).defaultPrevented, true);
  assert.equal(editor.blurs(), 0); assert.equal(f.panel.style.transform, undefined); assert.equal(f.panel.calls.length, 0);
  f.touch('touchend', 170, 201, 200);
  assert.equal(editor.blurs(), 1); assert.equal(f.closes(), 1);
  assert.equal(editor.input.value, 'Retained draft'); assert.equal(f.panel.calls.length, 0); f.control.dispose();
});

test('cancelled or short keyboard-open swipes preserve focus and text', () => {
  for (const kind of ['short', 'reverse', 'cancel', 'vertical']) {
    const f = fixture(), editor = focusEditor(f);
    f.touch('touchstart', 20, 200, 0);
    f.touch('touchmove', kind === 'vertical' ? 22 : 60, kind === 'vertical' ? 270 : 201, 100);
    if (kind === 'cancel') f.touch('touchcancel', 60, 201, 150, { fingers: 0 });
    if (kind === 'reverse') f.touch('touchmove', 25, 201, 250);
    f.touch('touchend', kind === 'reverse' ? 25 : 60, 201, 400);
    assert.equal(f.closes(), 0, kind); assert.equal(editor.blurs(), 0, kind);
    assert.equal(f.document.activeElement, editor.input); assert.equal(editor.input.selectionStart, 4);
    assert.equal(editor.input.value, 'Retained draft'); f.control.dispose();
  }
});

test('IME and new editing cancel the entire swipe; composition end only enables a new gesture', () => {
  for (const event of ['compositionstart', 'input', 'focusin']) {
    const f = fixture(), editor = focusEditor(f);
    f.touch('touchstart', 20, 200, 0); f.touch('touchmove', 90, 201, 100);
    f.panel.fire(event, { target: editor.input });
    f.panel.fire('compositionend', { target: editor.input });
    f.touch('touchend', 180, 201, 200);
    assert.equal(f.closes(), 0, event); assert.equal(editor.blurs(), 0, event);
    f.touch('touchstart', 20, 200, 400); f.touch('touchmove', 160, 201, 500); f.touch('touchend', 170, 201, 600);
    assert.equal(f.closes(), 1, event); f.control.dispose();
  }
  const f = fixture(), editor = focusEditor(f);
  f.panel.fire('compositionstart', { target: editor.input });
  f.touch('touchstart', 20, 200, 0); f.touch('touchmove', 160, 201, 100); f.touch('touchend', 170, 201, 200);
  assert.equal(f.closes(), 0); assert.equal(editor.blurs(), 0); f.control.dispose();
});

test('an editor selection or input-origin gesture remains protected while the keyboard is open', () => {
  for (const kind of ['selection', 'input-origin']) {
    const f = fixture(), editor = focusEditor(f, kind === 'selection');
    const at = kind === 'input-origin' ? editor.input : f.target;
    f.touch('touchstart', 20, 200, 0, { at });
    assert.equal(f.touch('touchmove', 160, 201, 100, { at }).defaultPrevented, false);
    f.touch('touchend', 170, 201, 200, { at });
    assert.equal(f.closes(), 0); assert.equal(editor.blurs(), 0); f.control.dispose();
  }
});

test('mobile entry holds reading and travels from the right, then restores all at-rest styles',()=>{
  const f=fixture({entry:true});assert.equal(f.holdCount(),1);assert.equal(f.phase(),'entering');
  assert.deepEqual(f.panel.calls[0].frames,[{transform:'translate3d(390px, 0, 0)'},{transform:'translate3d(0px, 0, 0)'}]);
  assert.equal(f.panel.calls[0].options.duration,240);assert.equal(f.workspace.style.transform,undefined);
  f.finish();assert.equal(f.holdCount(),0);assert.equal(f.phase(),undefined);assert.equal(f.panel.style.transform,undefined);assert.equal(f.workspace.attrs.size,0);f.control.dispose();
});

test('entry can reverse from its current visual position, close once, and hold reading until unmount',()=>{
  const f=fixture({entry:true});const entry=f.panel.calls[0].animation;f.panel.visualX=170;f.control.close();
  assert.equal(entry.cancelled,true);assert.equal(f.phase(),'exiting');assert.equal(f.holdCount(),1);
  assert.equal(f.panel.calls[1].frames[0].transform,'translate3d(170px, 0, 0)');
  f.control.close();assert.equal(f.panel.calls.length,2);entry.finish();assert.equal(f.closes(),0);
  f.finish();assert.equal(f.closes(),1);assert.equal(f.phase(),'closed');assert.equal(f.holdCount(),1);
  f.control.close();assert.equal(f.closes(),1);f.control.dispose();assert.equal(f.holdCount(),0);
});

test('a short edge drag follows the finger exactly and cancels back without closing',()=>{
  const f=fixture();f.touch('touchstart',20,200,0);
  assert.equal(f.touch('touchmove',26,201,30).defaultPrevented,false);
  assert.equal(f.touch('touchmove',75,202,100).defaultPrevented,true);
  assert.equal(f.panel.style.transform,'translate3d(55px, 0, 0)');assert.equal(f.holdCount(),1);
  f.touch('touchend',75,202,250);assert.equal(f.phase(),'settling');assert.equal(f.closes(),0);
  assert.equal(f.panel.calls[0].frames[0].transform,'translate3d(55px, 0, 0)');f.finish();
  assert.equal(f.panel.style.transform,undefined);assert.equal(f.holdCount(),0);f.control.dispose();
});

test('distance and recent velocity complete a gesture; old velocity after a pause does not',()=>{
  for(const kind of ['distance','velocity','paused']){
    const f=fixture();f.touch('touchstart',20,200,0);f.touch('touchmove',70,202,50);
    if(kind==='distance'){f.touch('touchmove',170,202,400);f.touch('touchend',175,202,450);}
    if(kind==='velocity')f.touch('touchend',90,202,70);
    if(kind==='paused')f.touch('touchend',70,202,250);
    assert.equal(f.phase(),kind==='paused'?'settling':'exiting',kind);f.finish();
    assert.equal(f.closes(),kind==='paused'?0:1,kind);f.control.dispose();
  }
});

test('dragging can interrupt an entry, preserving one shared reading hold',()=>{
  const f=fixture({entry:true});f.panel.visualX=80;
  f.touch('touchstart',20,200,0);f.touch('touchmove',60,201,80);
  assert.equal(f.panel.calls[0].animation.cancelled,true);assert.equal(f.panel.style.transform,'translate3d(120px, 0, 0)');assert.equal(f.holdCount(),1);
  f.touch('touchmove',25,200,140);f.touch('touchend',25,200,300);assert.equal(f.phase(),'settling');f.finish();assert.equal(f.closes(),0);f.control.dispose();
});

test('vertical, diagonal, outside-edge, long press, multiple touches and protected targets remain native',()=>{
  for(const kind of ['vertical','diagonal','outside','long','multi','control','horizontal','selection','overlay','editing']){
    const f=fixture();const target=new Node();target.parentElement=f.panel;
    if(kind==='control')target.closest=()=>({});
    if(kind==='horizontal'){target.scrollWidth=700;target.overflowX='auto';}
    if(kind==='selection')f.select(true);
    if(kind==='overlay')f.allow(false);
    if(kind==='editing'){f.document.activeElement=target;target.matches=()=>true;target.closest=()=>target;f.panel.children.push(target);}
    f.touch('touchstart',kind==='outside'?80:20,200,0,{at:target,fingers:kind==='multi'?2:1});
    const event=f.touch('touchmove',kind==='vertical'?23:kind==='diagonal'?60:170,kind==='vertical'?280:kind==='diagonal'?230:201,kind==='long'?450:100,{at:target});
    f.touch('touchend',180,202,200,{at:target});
    assert.equal(event.defaultPrevented,false,kind);assert.equal(f.panel.calls.length,0,kind);assert.equal(f.closes(),0,kind);assert.equal(f.holdCount(),0,kind);f.control.dispose();
  }
});

test('selection, pinch and native cancellation restore a claimed drag without animation or closing',()=>{
  for(const kind of ['selection','pinch','cancel','context']){
    const f=fixture();f.touch('touchstart',20,200,0);f.touch('touchmove',80,201,100);
    if(kind==='selection'){f.select(true);f.document.fire('selectionchange');}
    if(kind==='pinch')f.touch('touchmove',85,201,120,{fingers:2});
    if(kind==='cancel')f.touch('touchcancel',85,201,120,{fingers:0});
    if(kind==='context')f.panel.fire('contextmenu');
    assert.equal(f.phase(),undefined,kind);assert.equal(f.holdCount(),0,kind);assert.equal(f.panel.style.transform,undefined,kind);
    f.touch('touchend',180,202,200);assert.equal(f.closes(),0,kind);f.control.dispose();
  }
});

test('new editing or an action can cancel an exit and retain the original input node',()=>{
  for(const event of ['pointerdown','focusin','input']){
    const f=fixture();const input=new Node();input.closest=selector=>selector==='[data-inspector-close]'?null:input;f.panel.children.push(input);
    f.control.close();f.panel.visualX=70;f.panel.fire(event,{target:input});
    assert.equal(f.closes(),0);assert.equal(f.phase(),undefined);assert.equal(f.holdCount(),0);assert.equal(f.panel.children[0],input);f.control.dispose();
  }
});

test('desktop, keyboard, reduced motion and unavailable WAAPI all close without an animated wait',()=>{
  for(const options of [{desktop:true},{reduced:true},{animate:false}]){
    const f=fixture({...options,entry:true});assert.equal(f.panel.calls.length,0);f.control.close();assert.equal(f.closes(),1);f.control.dispose();
  }
  const f=fixture({entry:true});f.control.close(false);assert.equal(f.closes(),1);assert.equal(f.panel.calls.length,1);assert.equal(f.panel.calls[0].animation.cancelled,true);f.control.dispose();
});

test('reduced-motion swipes still navigate on release without following displacement',()=>{
  const f=fixture({reduced:true});f.touch('touchstart',20,200,0);f.touch('touchmove',160,201,100);f.touch('touchend',170,201,200);
  assert.equal(f.closes(),1);assert.equal(f.panel.calls.length,0);assert.equal(f.panel.style.transform,undefined);f.control.dispose();
});

test('pagehide before visibility changes retains the reading hold and never completes a hidden exit',()=>{
  const f=fixture();f.control.close();const exiting=f.panel.calls[0].animation;f.browser.fire('pagehide');
  assert.equal(f.holdCount(),1);assert.equal(f.panel.style.transform,undefined);assert.equal(f.phase(),undefined);
  exiting.finish();assert.equal(f.closes(),0);f.control.close(false);assert.equal(f.closes(),0);
  f.document.visibilityState='hidden';f.document.fire('visibilitychange');assert.equal(f.holdCount(),1);
  f.document.visibilityState='visible';f.browser.fire('pageshow');assert.equal(f.holdCount(),0);f.control.dispose();
});

test('resize and preference changes settle safely, preserving viewport height overrides',()=>{
  const f=fixture({entry:true});f.panel.style.setProperty('--inspector-viewport-height','390px');
  f.browser.fire('resize');assert.equal(f.phase(),undefined);assert.equal(f.holdCount(),0);assert.equal(f.panel.styleValues.get('--inspector-viewport-height'),'390px');
  f.control.close();f.media.matches=true;f.media.fire('change');assert.equal(f.closes(),1);f.control.dispose();
});

test('unmount cancels callbacks and removes every gesture, media and visibility listener',()=>{
  const f=fixture({entry:true});const running=f.panel.calls[0].animation;
  f.control.dispose();f.control.dispose();running.finish();assert.equal(f.closes(),0);assert.equal(f.holdCount(),0);
  for(const target of [f.panel,f.browser,f.document,f.narrow,f.media])assert.equal(target.listeners.length,0);
  assert.equal(f.workspace.attrs.size,0);assert.equal(f.panel.attrs.size,0);assert.equal(f.panel.style.transform,undefined);
});
