import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { URL, Response, caches, self, fetch: async request => { fetched = request.url; throw new Error('offline'); } });
  let pending; handlers.install({ waitUntil: value => { pending = value; } }); await pending;
  handlers.activate({ waitUntil: value => { pending = value; } }); await pending;
  assert.equal(stored.has('navigator-public-shell-v8'), false); assert.equal(stored.has('unrelated-cache'), true);
  assert.equal(skipped, 1); assert.equal(claimed, 1);
  const resources = [...stored.values()].flatMap(cache => [...cache.keys()]);
  assert.ok(resources.includes('/offline.html')); assert.ok(resources.every(path => !path.startsWith('/api/')));
  const original = 'https://example.test/?task=aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  handlers.fetch({ request: { url: original, method: 'GET', mode: 'navigate' }, respondWith: value => { pending = value; } });
  const html = await (await pending).text();
  const href = /<a\s+href="([^"]*)"[^>]*>重新连接<\/a>/.exec(html)?.[1];
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
    context,
  );
  let installing;handlers.install({waitUntil:p=>installing=p});await installing;
  assert.ok(cached.length>0&&cached.every(path=>path==='/offline.html'||path==='/theme.js'||path==='/startup.css'||path==='/manifest.webmanifest'||path.startsWith('/icons/')));
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
 vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,MessageChannel:Channel,setTimeout:(fn)=>setTimeout(fn,10),clearTimeout});
 let pending;handlers.push({data:{json:()=>({threadId:id,eventId:'event-1',body:'任务已完成'})},waitUntil:p=>pending=p});await pending;
 assert.equal(shown[0][0],'Pocket');assert.equal(shown[0][1].data.threadId,id);
 handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;
 assert.equal(messages[0].threadId,id);assert.equal(focused,1);assert.equal(opened.length,0);
 acknowledge=false;handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;assert.equal(navigated[0],`/?task=${id}`);
 self.clients.matchAll=async()=>[];handlers.notificationclick({notification:{close(){},data:{threadId:id}},waitUntil:p=>pending=p});await pending;
 assert.equal(opened[0],`/?task=${id}`);
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
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { caches, self });
  let pending; const install = () => { handlers.install({ waitUntil: p => { pending = p; } }); return pending; };
  await assert.rejects(install(), /Offline shell version is not ready/);
  assert.equal(skipped, 0); assert.equal(claimed, 0); assert.ok(stored.has(old));
  stale = false; await install(); assert.equal(skipped, 1);
  handlers.activate({ waitUntil: p => { pending = p; } }); await pending;
  assert.equal(claimed, 1); assert.equal(stored.has(old), false);
  assert.ok([...stored.values()].some(cache => cache.get('/offline.html') === current));
});
