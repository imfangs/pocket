import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import profile from "./fixtures/client-profile.json" with { type: "json" };

test('public shell upgrade retains deep links on offline retry and never adds private resources to the cache', async () => {
  const handlers = {}, stored = new Map([['navigator-public-shell-v8', new Map([['/offline.html', 'old shell']])], ['unrelated-cache', new Map()]]);
  const offline = readFileSync(new URL('../public/offline.html', import.meta.url), 'utf8');
  let skipped = 0, claimed = 0, fetched;
  const caches = {
    open: async name => { const cache = new Map(); stored.set(name, cache); return { addAll: async files => { for (const path of files) cache.set(path, path === '/offline.html' ? offline : 'public asset'); }, match: async path => cache.has(path) ? new Response(cache.get(path)) : undefined }; },
    keys: async () => [...stored.keys()], delete: async name => stored.delete(name),
    match: async path => { for (const cache of stored.values()) if (cache.has(path)) return new Response(cache.get(path)); },
  };
  const self = { location: { origin: 'https://example.test' }, addEventListener: (type, listener) => { handlers[type] = listener; },
    skipWaiting: async () => { skipped++; }, clients: { claim: async () => { claimed++; } } };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { POCKET_CLIENT_CONFIG:profile, URL, Response, caches, self, fetch: async request => { fetched = request.url; throw new Error('offline'); } });
  let pending; handlers.install({ waitUntil: value => { pending = value; } }); await pending;
  handlers.activate({ waitUntil: value => { pending = value; } }); await pending;
  assert.equal(stored.has('navigator-public-shell-v8'), false); assert.equal(stored.has('unrelated-cache'), true);
  assert.equal(skipped, 1); assert.equal(claimed, 1);
  const resources = [...stored.values()].flatMap(cache => [...cache.keys()]);
  assert.ok(stored.has('navigator-public-shell-v13'));
  assert.ok(resources.includes('/offline.html')); assert.ok(resources.includes('/language.js'));
  assert.ok(resources.every(path => !path.startsWith('/api/')));
  const original = 'https://example.test/?task=aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  handlers.fetch({ request: { url: original, method: 'GET', mode: 'navigate' }, respondWith: value => { pending = value; } });
  const html = await (await pending).text();
  const href = /<a\s+href="([^"]*)"[^>]*data-shell-text="reconnect"[^>]*>Reconnect<\/a>/.exec(html)?.[1];
  assert.equal(fetched, original); assert.notEqual(href, undefined);
  assert.equal(new URL(href, original).href, original);
});

test("worker handles real fetch failures and 502 navigations with only the public offline response", async () => {
  const handlers = {};
  let fail = true;
  let cached=[];
  const navigationFetches=[];
  const context = {
    URL,
    Response,
    fetch: async (_request, options) => {
      navigationFetches.push(options);
      if (fail) throw new Error("offline");
      return new Response("origin unavailable", { status: 502 });
    },
    caches: {
      open:async()=>({addAll:async files=>{cached=[...files];},match:async()=>new Response(readFileSync(new URL('../public/offline.html', import.meta.url),'utf8'))}),
      match: async (path) => {
        assert.equal(path, "/offline.html");
        return new Response("PUBLIC OFFLINE PAGE");
      },
    },
    self: {
      skipWaiting:async()=>{},
      location: { origin: "https://example.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { ...context,POCKET_CLIENT_CONFIG:profile },
  );
  let installing;handlers.install({waitUntil:p=>installing=p});await installing;
  assert.ok(cached.includes('/language.js') && cached.includes('/client-config.js'));
  assert.ok(cached.length>0&&cached.every(path=>path==='/offline.html'||path==='/theme.js'||path==='/language.js'||path==='/client-config.js'||path==='/startup.css'||path==='/manifest.webmanifest'||path.startsWith('/icons/')));
  const navigation = async () => {
    let promise;
    handlers.fetch({
      request: {
        url: "https://example.test/",
        method: "GET",
        mode: "navigate",
      },
      respondWith: (p) => (promise = p),
    });
    return (await promise).text();
  };
  assert.equal(await navigation(), "PUBLIC OFFLINE PAGE");
  assert.equal(navigationFetches.at(-1).cache,"no-store");
  fail = false;
  assert.equal(await navigation(), "PUBLIC OFFLINE PAGE");
  let intercepted = false;
  handlers.fetch({
    request: {
      url: "https://example.test/api/catalog",
      method: "GET",
      mode: "navigate",
    },
    respondWith: () => (intercepted = true),
  });
  assert.equal(intercepted, false);
  handlers.fetch({
    request: { url: "https://example.test/startup.css?v=new-build", method: "GET", mode: "cors" },
    respondWith: () => (intercepted = true),
  });
  assert.equal(intercepted, false, "versioned startup styles must bypass an old installed worker cache");
});

test('push shows a notification without caching private data and click reuses a window without reloading drafts',async()=>{
 const handlers={},shown=[],messages=[],opened=[],navigated=[];let focused=0,acknowledge=true;
 class Channel {constructor(){this.port1={close(){}};this.port2={ack:()=>this.port1.onmessage({data:'pocket-task-received'})};}}
 const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,
  registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[{url:'https://example.test/',postMessage:(m,ports)=>{messages.push(m);if(acknowledge)ports[0].ack();},focus:async()=>focused++,navigate:async url=>navigated.push(url)}],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL,MessageChannel:Channel,setTimeout:(fn)=>setTimeout(fn,10),clearTimeout});
 let pending;handlers.push({data:{json:()=>({threadId:id,eventId:'event-1',body:'任务已完成',title:'Named conversation'})},waitUntil:p=>pending=p});await pending;
 assert.equal(shown[0][0],'【已完成】Named conversation');assert.equal(shown[0][1].body,'');assert.equal(shown[0][1].data.threadId,id);assert.equal(shown[0][1].data.machineId,'ged');
 handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;
 assert.equal(messages[0].threadId,id);assert.equal(focused,1);assert.equal(opened.length,0);
 acknowledge=false;handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;assert.equal(navigated.length,0);assert.equal(opened[0],`/?task=${id}`);
 self.clients.matchAll=async()=>[];handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;
 assert.equal(opened[0],`/?task=${id}`);
});

test('push clicks choose the correct machine even for identical thread IDs and never navigate another machine', async () => {
 const handlers={},shown=[],messages=[],opened=[];
 const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 class Channel {constructor(){this.port1={close(){}};this.port2={ack:()=>this.port1.onmessage({data:'pocket-task-received'})};}}
 const client=machine=>({url:`https://example.test/?machine=${machine}`,focus:async()=>{},postMessage:(message,ports)=>{messages.push({machine,...message});ports[0].ack()},navigate:async()=>{throw Error('Existing drafts must not be replaced')}});
 const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[client('ged'),client('wandou')],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL,MessageChannel:Channel,setTimeout,clearTimeout});
 let pending;
 for(const machineId of ['ged','wandou']) {handlers.push({data:{json:()=>({threadId:id,machineId,eventId:'same-event',body:'任务已完成'})},waitUntil:p=>pending=p});await pending;}
 assert.deepEqual(shown.map(([title])=>title),['【已完成】Pocket','【已完成】Pocket']);
 assert.notEqual(shown[0][1].tag,shown[1][1].tag);
 handlers.notificationclick({notification:{close(){},data:{threadId:id,machineId:'wandou'}},waitUntil:p=>pending=p});await pending;
 assert.equal(messages.length,1);assert.equal(messages[0].machine,'wandou');assert.equal(messages[0].type,'pocket-open-machine-task');
 self.clients.matchAll=async()=>[client('ged')];
 handlers.notificationclick({notification:{close(){},data:{threadId:id,machineId:'wandou'}},waitUntil:p=>pending=p});await pending;
 assert.equal(opened.at(-1),`/?machine=wandou&task=${id}`);assert.equal(messages.length,1);
 handlers.push({data:{json:()=>({threadId:id,machineId:'unknown',body:'ignore'})},waitUntil:()=>{throw Error('Unknown machine must not notify')}});
 assert.equal(shown.length,2);
});


test('a mixed CDN rollout cannot activate an old offline page under a new shell version', async () => {
  const handlers = {}, old = 'navigator-public-shell-v8', stored = new Map([[old, new Map([['/offline.html', 'previous page']])]]);
  const current = readFileSync(new URL('../public/offline.html', import.meta.url), 'utf8');
  let stale = true, skipped = 0, claimed = 0;
  const caches = {
    open: async name => {
      const entries = stored.get(name) || new Map(); stored.set(name, entries);
      return { addAll: async paths => paths.forEach(path => entries.set(path, path === '/offline.html' ? stale ? 'previous page' : current : 'public asset')),
        match: async path => entries.has(path) ? new Response(entries.get(path)) : undefined };
    },
    keys: async () => [...stored.keys()], delete: async key => stored.delete(key),
  };
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => { skipped++; }, clients: { claim: async () => { claimed++; } } };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { POCKET_CLIENT_CONFIG:profile, caches, self });
  let pending; const install = () => { handlers.install({ waitUntil: p => { pending = p; } }); return pending; };
  await assert.rejects(install(), /Offline shell version is not ready/);
  assert.equal(skipped, 0); assert.equal(claimed, 0); assert.ok(stored.has(old));
  stale = false; await install(); assert.equal(skipped, 1);
  handlers.activate({ waitUntil: p => { pending = p; } }); await pending;
  assert.equal(claimed, 1); assert.equal(stored.has(old), false);
  assert.ok([...stored.values()].some(cache => cache.get('/offline.html') === current));
});


test('a failed public bootstrap keeps the previous worker despite later successful cache fetches',async()=>{
  const handlers={};let skipped=0,filled=0;
  const self={addEventListener:(name,callback)=>handlers[name]=callback,skipWaiting:async()=>skipped++};
  const caches={open:async()=>({addAll:async()=>filled++,match:async()=>new Response('valid public shell')})};
  vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,caches,Response,importScripts:()=>{throw new Error('temporary bootstrap failure');}});
  let pending;handlers.install({waitUntil:value=>pending=value});
  await assert.rejects(pending,/Client configuration is not ready/);assert.equal(skipped,0);assert.equal(filled,0);
});

test('push title combines a compact status with the bounded authored name and older payloads keep the Pocket fallback',async()=>{
 const handlers={},shown=[];const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 const self={addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification:async(...args)=>shown.push(args)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL});
 for(const [title,expected] of [[undefined,'【已完成】Pocket'],[false,'【已完成】Pocket'],['\n\u0000\t','【已完成】Pocket'],['  Named\nconversation  ','【已完成】Named conversation'],['😀'.repeat(130),'【已完成】'+'😀'.repeat(115)]]){
  let pending;handlers.push({data:{json:()=>({title,threadId:id,eventId:'bounded-title',body:'任务已完成'})},waitUntil:p=>pending=p});await pending;
  assert.equal(shown.at(-1)[0],expected);assert.equal(shown.at(-1)[1].body,'');
 }
});

test('push status titles omit duplicate text and source labels while unknown statuses remain readable',async()=>{
 const handlers={},shown=[];const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 const self={addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification:async(...args)=>shown.push(args)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL});
 for(const [body,expected,detail] of [['任务已完成','【已完成】合成会话',''],['任务执行失败','【失败】合成会话',''],['任务需要你处理','【待处理】合成会话',''],['未来状态','合成会话','未来状态'],['toString','合成会话','toString']]){
  let pending;handlers.push({data:{json:()=>({title:'合成会话',body,threadId:id,machineId:'wandou',eventId:'compact-status'})},waitUntil:p=>pending=p});await pending;
  const [title,options]=shown.at(-1);assert.equal(title,expected);assert.equal(options.body,detail);
  assert.equal(options.data.threadId,id);assert.equal(options.data.machineId,'wandou');assert.equal(options.tag,'pocket-wandou-compact-status');
 }
});

test('notification clicks reuse only an application window, not nested previews or unrelated same-origin pages',async()=>{
 const handlers={},messages=[],focus=[],opened=[];const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 class Channel{constructor(){this.port1={close(){}};this.port2={ack:()=>this.port1.onmessage({data:'pocket-task-received'})};}}
 const client=(url,frameType)=>({url,frameType,focus:async()=>focus.push(url),postMessage:(data,ports)=>{messages.push({url,data});ports[0].ack();},navigate:async()=>assert.fail('draft window must not reload')});
 const candidates=[client('https://example.test/html-preview-shell.html#private-preview','top-level'),client('https://example.test/?task='+id,'nested'),client('https://example.test/docs/diagram.html','top-level'),client('not a URL','top-level'),client('https://other.example.test/','top-level'),client('https://example.test/?machine=ged','top-level')];
 const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>candidates,openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL,MessageChannel:Channel,setTimeout,clearTimeout});
 let pending;handlers.notificationclick({notification:{close(){},data:{threadId:id,machineId:'ged'}},waitUntil:p=>pending=p});await pending;
 assert.deepEqual(focus,['https://example.test/?machine=ged']);assert.equal(messages.length,1);assert.equal(opened.length,0);
 self.clients.matchAll=async()=>candidates.slice(0,-1);handlers.notificationclick({notification:{close(){},data:{threadId:id,machineId:'ged'}},waitUntil:p=>pending=p});await pending;
 assert.equal(opened.at(-1),'/?task='+id);assert.equal(messages.length,1);
});

test('an unfocusable or closed notification window falls back to a new scoped target without replacing drafts',async()=>{
 const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
 for(const phase of ['focus','message']){
  const handlers={},opened=[];class Channel{constructor(){this.port1={close(){}};this.port2={};}}
  const client={url:'https://example.test/?machine=wandou',frameType:'top-level',focus:async()=>{if(phase==='focus')throw Error('closed')},postMessage:()=>{throw Error('closed')},navigate:async()=>assert.fail('never reload drafts')};
  const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>[client],openWindow:async url=>opened.push(url)}};
  vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{POCKET_CLIENT_CONFIG:profile,self,URL,MessageChannel:Channel,setTimeout,clearTimeout});
  let pending;handlers.notificationclick({notification:{close(){},data:{threadId:id,machineId:'wandou'}},waitUntil:p=>pending=p});await pending;
  assert.deepEqual(opened,[`/?machine=wandou&task=${id}`]);
 }
});
