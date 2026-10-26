import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
// Portal targets are DOM refs, so SSR cannot render their action subtree. Capture
// the real Conversation boundary props; controller actions have their own tests.
const probeKey = Symbol.for('pocket.ssr.conversation-actions.test.mjs');
globalThis[probeKey] = {};
const controllerBoundary = {
  name: 'capture-conversation-controller-props', enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.endsWith('/src/Conversation.tsx') && ['./Outbox'].includes(source))
      return '\0' + 'pocket.ssr.conversation-actions.test.mjs' + source;
  },
  load(id) {
    if (!id.startsWith('\0' + 'pocket.ssr.conversation-actions.test.mjs')) return;
    const name = id.endsWith('/Outbox') ? 'outbox' : 'submitted';
    return `export default function ControllerBoundary(props) { globalThis[Symbol.for(${JSON.stringify('pocket.ssr.conversation-actions.test.mjs')})][${JSON.stringify(name)}] = props; return null; }`;
  },
};

const vite=await createServer({plugins:[controllerBoundary],configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
const {default:Conversation}=await vite.ssrLoadModule('/src/Conversation.tsx');
after(async()=>{delete globalThis[probeKey];await vite.close();});
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
function render(override={},thread={}) {
 const history={source:'rollout',runtime:'unavailable',canSend:false,canQueue:true,canAttemptSend:true,messages:[],outbox:[{id:'q',text:'Next',status:'queued',revision:0}],checkedAt:Date.now(),...override};
 globalThis[probeKey]={};
 const html=renderToStaticMarkup(createElement(Conversation,{thread:{id,archived:false,missing:false,...thread},drafts:new Map([[id,{text:'Another question'}]]),historyCache:new Map([[id,{history,scrollTop:0,nearBottom:true}]]),onConnect:async()=>{}}));
 return { html, queue:globalThis[probeKey].outbox,
  buttons:[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m=>({text:m[2].replace(/<[^>]*>/g,'').trim(),disabled:/\bdisabled(?:=|\s|$)/.test(m[1])})) };
}
test('temporary desktop history fallback does not disable storing or explicitly trying a queued message',()=>{
 const ui=render();
 assert.equal(ui.buttons.find(b=>b.text==='加入队列')?.disabled,false);
 assert.equal(ui.queue.allowSend,true);
 assert.equal(ui.queue.disabled,false);
 assert.equal(ui.queue.items[0].status,'queued');
 assert.match(ui.html,/data-query-id="q"/);
});
test('known approval blockers still prohibit immediate send, but allow storing the next query',()=>{
 const ui=render({source:'desktop',runtime:'active',canAttemptSend:false,pendingRequests:[{key:'k',kind:'command',command:'echo test',cwd:'/sample',choices:['cancel']}]});
 assert.equal(ui.buttons.find(b=>b.text==='加入队列')?.disabled,false);
 assert.equal(ui.queue.allowSend,false);
 assert.equal(ui.queue.items[0].status,'queued');
});
test('archived tasks cannot enqueue or directly dispatch and unknown submissions only offer verification',()=>{
 const ui=render({}, {archived:true});
 assert.equal(ui.buttons.find(b=>b.text==='加入队列')?.disabled,true);
 assert.equal(ui.queue.allowSend,false);
 assert.equal(ui.queue.items[0].status,'queued', 'archiving does not silently discard the saved query');
 const unknown=render({outbox:[{id:'q',text:'Next',status:'unknown',revision:0}]});
 assert.equal(unknown.queue.items[0].status,'unknown', 'the controller receives verification-only state, not a mutable queued state');
 assert.ok(unknown.queue.inlineTargets instanceof Map);
 assert.match(unknown.html,/data-query-state="unknown"/);
});
