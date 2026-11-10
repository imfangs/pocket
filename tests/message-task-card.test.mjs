import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';import {fileURLToPath} from 'node:url';
const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});after(()=>vite.close());
const {default:ConversationMessage}=await vite.ssrLoadModule('/src/ConversationMessage.tsx');
const {TaskReferencesProvider}=await vite.ssrLoadModule('/src/MessageTaskCard.tsx');
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const token=uuid=>`::created-thread{threadId="${uuid}"}`;
const render=(text,extra={},props={})=>renderToStaticMarkup(createElement(TaskReferencesProvider,{machine:'ged',scope:'scope',threads:[{id,title:'Known project task',projectName:'Project',cwd:'/synthetic/path',archived:false}],...props},createElement(ConversationMessage,{threadId:second,message:{id:'message',role:'assistant',phase:'final',text,...extra}})));
test('created directives render whole task cards with actual metadata and no fabricated completed state',()=>{
 const html=render(`Before.\n\n${token(id)}\n${token(second)}\n\nAfter.`);
 assert.equal((html.match(/class="message-task-card"/g)||[]).length,2);assert.match(html,/Known project task/);assert.match(html,/Project/);assert.match(html,/Before/);assert.match(html,/After/);assert.doesNotMatch(html,/已完成|Completed|::created-thread/);
 assert.match(html,new RegExp('href="/\\?task='+id+'"'));
});
test('ordinary links, user source, code and quotations never acquire task cards',()=>{
 for(const [text,extra] of [[`[Link](codex://threads/${id})`,{}],[token(id),{role:'user'}],[`> ${token(id)}`,{}],[`\`${token(id)}\``,{}],[`<details><summary>Example</summary>\n\n${token(id)}\n\n</details>`,{}]])assert.doesNotMatch(render(text,extra),/class="message-task-card"/);
});
test('metadata belongs to the current machine and a known scope, including exclusions',()=>{
 for(const props of [{machine:'wandou'},{scope:undefined},{scope:'unknown'},{excluded:[id]},{threads:[{id,title:'Excluded title',sourceExcluded:true}]}]){
  const html=render(token(id),{},props);assert.doesNotMatch(html,/Known project task|Excluded title/);assert.match(html,/会话详情暂未同步/);
 }
});
test('known live states and archival are readable, absent or idle states do not infer completion',()=>{
 for(const status of ['running','waiting_input','waiting_approval'])assert.match(render(token(id),{},{states:new Map([[id,status]])}),new RegExp('data-state="'+status+'"'));
 assert.doesNotMatch(render(token(id),{},{states:new Map([[id,'idle']])}),/已完成|Completed/);
 assert.match(render(token(id),{},{threads:[{id,title:'Archived',archived:true,projectName:'Project'}]}),/已归档/);
});
test('references across card boundaries retain the first definition and code keeps its literal marker',()=>{
 const html=render(`[source][ref]\n\n${token(id)}\n\n[ref]: https://example.test/source\n\n\`${token(second)}\``);
 assert.match(html,/href="https:\/\/example.test\/source"/);assert.equal((html.match(/class="message-task-card"/g)||[]).length,1);assert.match(html,/::created-thread/);
});
