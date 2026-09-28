import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true},appType:'custom'});
const {default:Conversation}=await vite.ssrLoadModule('/src/Conversation.tsx');
after(()=>vite.close());
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
function buttons(override={},thread={}) {
 const history={source:'rollout',runtime:'unavailable',canSend:false,canQueue:true,canAttemptSend:true,messages:[],outbox:[{id:'q',text:'Next',status:'queued',revision:0}],checkedAt:Date.now(),...override};
 const html=renderToStaticMarkup(createElement(Conversation,{thread:{id,archived:false,missing:false,...thread},drafts:new Map([[id,{text:'Another question'}]]),historyCache:new Map([[id,{history,scrollTop:0,nearBottom:true}]]),onConnect:async()=>{}}));
 return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m=>({text:m[2].replace(/<[^>]*>/g,'').trim(),disabled:/\bdisabled(?:=|\s|$)/.test(m[1])}));
}
test('temporary desktop history fallback does not disable storing or explicitly trying a queued message',()=>{
 const ui=buttons();
 assert.equal(ui.find(b=>b.text==='加入队列')?.disabled,false);
 assert.equal(ui.find(b=>b.text==='直接发送')?.disabled,false);
});
test('known approval blockers still prohibit immediate send, but allow storing the next query',()=>{
 const ui=buttons({source:'desktop',runtime:'active',canAttemptSend:false,pendingRequests:[{key:'k',kind:'command',command:'echo test',cwd:'/sample',choices:['cancel']}]});
 assert.equal(ui.find(b=>b.text==='加入队列')?.disabled,false);
 assert.equal(ui.find(b=>b.text==='直接发送')?.disabled,true);
});
test('archived tasks cannot enqueue or directly dispatch and unknown submissions only offer verification',()=>{
 const ui=buttons({}, {archived:true});
 assert.equal(ui.find(b=>b.text==='加入队列')?.disabled,true);
 assert.equal(ui.find(b=>b.text==='直接发送')?.disabled,true);
 assert.equal(buttons({outbox:[{id:'q',text:'Next',status:'unknown',revision:0}]}).some(b=>b.text==='直接发送'),false);
});
