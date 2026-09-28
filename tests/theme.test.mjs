import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../public/theme.js',import.meta.url),'utf8');
function boot(saved,systemDark=false,storageFails=false){
 const window=new EventTarget(),media=new EventTarget(),values=new Map(saved?[['pocket.theme',saved]]:[]),root={dataset:{},style:{}},meta={};
 media.matches=systemDark;window.matchMedia=()=>media;
 const localStorage={getItem:k=>{if(storageFails)throw Error('denied');return values.get(k)||null;},setItem:(k,v)=>{if(storageFails)throw Error('denied');values.set(k,v);}};
 vm.runInNewContext(script,{window,document:{documentElement:root,querySelector:()=>({setAttribute:(k,v)=>meta[k]=v})},localStorage,Event});
 return {root,meta,values,set:value=>window.dispatchEvent(new CustomEvent('pocket-set-theme',{detail:value})),system:value=>{media.matches=value;media.dispatchEvent(new Event('change'));},storage:value=>{values.set('pocket.theme',value);const e=new Event('storage');e.key='pocket.theme';window.dispatchEvent(e);}};
}
test('theme restores before React mounts, persists choice and only follows OS when selected',()=>{
 const f=boot('dark',false);assert.equal(f.root.dataset.theme,'dark');assert.equal(f.meta.content,'#18181e');
 f.system(false);assert.equal(f.root.dataset.theme,'dark');
 f.set('light');assert.equal(f.values.get('pocket.theme'),'light');assert.equal(f.root.style.colorScheme,'light');
 f.system(true);assert.equal(f.root.dataset.theme,'light');
 f.set('system');assert.equal(f.root.dataset.theme,'dark');f.system(false);assert.equal(f.root.dataset.theme,'light');
 f.storage('dark');assert.equal(f.root.dataset.theme,'dark');
});
test('invalid and unavailable browser storage never blocks theme selection',()=>{
 assert.equal(boot('invalid',true).root.dataset.theme,'dark');
 const f=boot(null,false,true);f.set('dark');assert.equal(f.root.dataset.theme,'dark');
 f.set('invalid');assert.equal(f.root.dataset.theme,'dark');
});
test('dark primary, secondary, accent and inverse text retain readable contrast',()=>{
 const css=readFileSync(new URL('../src/theme.css',import.meta.url),'utf8');const block=css.match(/html\[data-theme="dark"\]\s*\{([^}]+)/)[1];
 const vars=Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/g)].map(m=>[m[1],m[2]]));
 const lum=hex=>{const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const ratio=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 for(const [fg,bg] of [['--ink','--surface'],['--text-secondary','--surface-raised'],['--muted','--surface-raised'],['--accent','--accent-soft'],['--on-strong','--ink']])assert.ok(ratio(vars[fg],vars[bg])>=4.5,`${fg} on ${bg}`);
});
