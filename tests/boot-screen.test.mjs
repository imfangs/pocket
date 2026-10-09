import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootScreenController } from '../src/bootScreen.ts';

function fixture() {
  const screen={hidden:false},frames=new Map();let id=0;
  const controller=createBootScreenController({screen:()=>screen,
    requestFrame:callback=>{frames.set(++id,callback);return id;},cancelFrame:id=>frames.delete(id)});
  return{screen,controller,paint:()=>{const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback());}};
}
test('authentication, lazy code and catalog stages share one uninterrupted screen',()=>{
  const f=fixture();
  const auth=f.controller.hold();auth();
  const lazy=f.controller.hold();f.paint();assert.equal(f.screen.hidden,false);
  lazy();const catalog=f.controller.hold();f.paint();assert.equal(f.screen.hidden,false);
  catalog();assert.equal(f.screen.hidden,false);f.paint();assert.equal(f.screen.hidden,true);
});
test('overlapping stages cannot hide a still-needed loader',()=>{
  const f=fixture(),one=f.controller.hold(),two=f.controller.hold();
  one();f.paint();assert.equal(f.screen.hidden,false);
  two();f.paint();assert.equal(f.screen.hidden,true);
});
test('StrictMode cleanup and repeated release do not prematurely hide the screen',()=>{
  const f=fixture(),first=f.controller.hold();first();first();
  const second=f.controller.hold();f.paint();assert.equal(f.screen.hidden,false);
  first();f.paint();assert.equal(f.screen.hidden,false);
  second();f.paint();assert.equal(f.screen.hidden,true);
});
test('a later loading attempt can reuse the same previously hidden screen',()=>{
  const f=fixture(),first=f.controller.hold();first();f.paint();
  const second=f.controller.hold();assert.equal(f.screen.hidden,false);
  second();f.paint();assert.equal(f.screen.hidden,true);
});
test('an unavailable document screen does not crash error or isolated rendering paths',()=>{
  let callback;
  const controller=createBootScreenController({screen:()=>null,requestFrame:fn=>{callback=fn;return 1;},cancelFrame:()=>{}});
  assert.doesNotThrow(()=>{controller.hold()();callback();});
});
