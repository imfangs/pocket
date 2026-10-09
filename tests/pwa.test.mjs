import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
      open:async()=>({addAll:async files=>{cached=[...files];}}),
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
