import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {Check,Square,Star,X} from 'lucide-react';

const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
const {AppIcon}=await vite.ssrLoadModule('/src/ui/AppIcon.tsx');
after(()=>vite.close());
const render=props=>renderToStaticMarkup(createElement(AppIcon,{icon:X,...props}));

test('icon roles render one consistent size and stroke without labeling decorative shapes',()=>{
  for(const[kind,size]of[['auxiliary',16],['action',18],['navigation',20]]){
    const html=render({kind});assert.match(html,new RegExp(`width="${size}" height="${size}"`));
    assert.match(html,/stroke-width="1.75"/);assert.match(html,/aria-hidden="true"/);
    assert.match(html,new RegExp(`data-pocket-icon="${kind}"`));
  }
});

test('named status marks keep their original semantics while explicit zero strokes remain valid',()=>{
  const named=render({icon:Star,kind:'marker',role:'img','aria-label':'Pocket priority'});
  assert.match(named,/width="13" height="13"/);assert.match(named,/stroke-width="2"/);
  assert.match(named,/role="img"/);assert.doesNotMatch(named,/aria-hidden="true"/);
  const stop=render({icon:Square,kind:'marker',size:11,strokeWidth:0,fill:'currentColor'});
  assert.match(stop,/width="11" height="11"/);assert.match(stop,/stroke-width="0"/);assert.match(stop,/fill="currentColor"/);
});

test('explicit accessibility and motion classes survive the shared wrapper',()=>{
  const html=render({icon:Check,kind:'auxiliary','aria-hidden':false,'aria-label':'Done',className:'receipt-check', 'data-test-icon':'kept'});
  assert.match(html,/aria-hidden="false"/);assert.match(html,/aria-label="Done"/);
  assert.match(html,/receipt-check/);assert.match(html,/data-test-icon="kept"/);
});
