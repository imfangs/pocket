import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const previous=global.window;
const events=new EventTarget();
global.window={location:{search:'?machine=wandou',href:'https://pocket.example.com/?machine=wandou',origin:'https://pocket.example.com'},localStorage:{getItem:()=>null},
 addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events)};
const vite=await createServer({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
const [{default:MessageImage},{default:AttachmentList},{default:MessageMarkdown},{default:MachinePicker}]=await Promise.all([vite.ssrLoadModule('/src/MessageImage.tsx'),vite.ssrLoadModule('/src/AttachmentList.tsx'),vite.ssrLoadModule('/src/MessageMarkdown.tsx'),vite.ssrLoadModule('/src/MachinePicker.tsx')]);
after(async()=>{global.window=previous;await vite.close()});
const thread='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',upload='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',imagePath=`/api/tasks/${thread}/images/${'f'.repeat(64)}`,attachmentPath=`/api/tasks/${thread}/attachments/${upload}`;
test('message images add machine routing only at the actual image source',()=>{
 const html=renderToStaticMarkup(createElement(MessageImage,{src:imagePath,alt:'picture'}));
 assert.ok(html.includes(`src="/api/machines/wandou${imagePath.slice(4)}"`));assert.match(html,/aria-label="查看大图：picture"/);
});
test('attachment previews and downloads stay on the selected machine while canonical records remain unchanged',()=>{
 const photo=Object.freeze({id:upload,name:'photo.png',kind:'image',url:attachmentPath,previewUrl:attachmentPath+'?preview=1',mime:'image/png',size:10,sha256:'f'.repeat(64)});
 const file=Object.freeze({...photo,id:'cccccccc-cccc-7ccc-8ccc-cccccccccccc',name:'file.txt',kind:'file',url:`/api/tasks/${thread}/attachments/cccccccc-cccc-7ccc-8ccc-cccccccccccc`,previewUrl:undefined});
 const html=renderToStaticMarkup(createElement(AttachmentList,{attachments:[photo,file]}));
 assert.ok(html.includes(`src="/api/machines/wandou${photo.previewUrl.slice(4)}"`));assert.ok(html.includes(`href="/api/machines/wandou${file.url.slice(4)}"`));assert.match(html,/download="file.txt"/);assert.equal(photo.url,attachmentPath);
});
test('registered Markdown images and native thread links retain the current machine and old Pocket links retain ged',()=>{
 const html=renderToStaticMarkup(createElement(MessageMarkdown,{text:`![picture](/source.png)\n\n[native](codex://threads/${thread})\n\n[old](/?task=${thread})\n\n::created-thread{threadId="${thread}"}`,images:{'/source.png':imagePath}}));
 assert.ok(html.includes(`/api/machines/wandou${imagePath.slice(4)}`));assert.ok(html.includes(`href="/?machine=wandou&amp;task=${thread}"`));assert.ok(html.includes(`href="/?machine=ged&amp;task=${thread}"`));
});
test('machine picker shows the current named target and independent choices without accepting arbitrary machines',()=>{
 const html=renderToStaticMarkup(createElement(MachinePicker));assert.match(html,/aria-label="选择电脑"/);assert.match(html,/value="wandou" selected="">豌豆 Mac/);assert.match(html,/value="ged">格得 Mac/);
});
