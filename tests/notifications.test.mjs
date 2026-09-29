import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { NavigatorStore } from '../server/store.mjs';
import { AccessControl } from '../server/auth.mjs';
import { Notifications, validateSubscription } from '../server/notifications.mjs';
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
function subscription(endpoint = 'https://web.push.apple.com/fixture') {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'pocket-push-')), store = new NavigatorStore(directory);
  store.sync({threads:[{id,title:'Private task title',archived:false,updatedAt:1000}],projects:[],sourceInfo:{}});
  const state = { now:1000000, history:{source:'desktop',runtime:'active',latestTurnId:'turn-1',latestTurnStatus:'inProgress',pendingRequests:[]}, sends:[] };
  const options = {now:()=>state.now,send:async(...args)=>{state.sends.push(args);if(state.error)throw state.error;}};
  const desktop = {history:async()=>state.history}, service = new Notifications(store,desktop,options);
  t.after(()=>{service.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,service,state,directory,options,desktop};
}
test('push subscriptions reject arbitrary URLs, loopback, credentials, ports and invalid keys',()=>{
  for(const endpoint of ['http://web.push.apple.com/x','https://127.0.0.1/x','https://web.push.apple.com.evil.test/x','https://user@web.push.apple.com/x','https://web.push.apple.com:8000/x'])
    assert.throws(()=>validateSubscription(subscription(endpoint)),e=>e.status===400);
  assert.throws(()=>validateSubscription({endpoint:'https://web.push.apple.com/x',keys:{auth:'bad',p256dh:'bad'}}));
  assert.equal(validateSubscription(subscription()).endpoint,'https://web.push.apple.com/fixture');
});
test('only fresh owner transitions notify; fallback reads and an old completed task do not',async t=>{
  const {service:s,state,store}=fixture(t);s.subscribe(subscription());
  s.watch(id,{...state.history,runtime:'idle',latestTurnStatus:'completed'});assert.equal(store.db.prepare('SELECT count(*) AS n FROM push_deliveries').get().n,0);
  s.watch(id,state.history);
  state.history={source:'rollout',runtime:'idle',latestTurnStatus:'completed'};state.now+=11000;await s.tick();assert.equal(state.sends.length,0);
  state.history={source:'desktop',runtime:'idle',latestTurnId:'turn-1',latestTurnStatus:'completed',pendingRequests:[]};state.now+=11000;await s.tick();
  assert.equal(state.sends.length,1);const payload=JSON.parse(state.sends[0][1]);assert.equal(payload.body,'任务已完成');assert.equal(payload.threadId,id);assert.ok(!state.sends[0][1].includes('Private'));
  state.now+=11000;await s.tick();assert.equal(state.sends.length,1);
});
test('attention is deduplicated across reload and restart, keys stay private',async t=>{
  const {service:s,state,store,directory,desktop,options}=fixture(t);s.subscribe(subscription());s.watch(id,state.history);
  state.history={...state.history,pendingRequests:[{key:'request'}]};s.watch(id,state.history);await s.deliver();assert.equal(state.sends.length,1);
  const next=new Notifications(store,desktop,options);next.watch(id,state.history);await next.deliver();assert.equal(state.sends.length,1);next.stop();
  assert.equal(statSync(join(directory,'web-push-keys.json')).mode&0o777,0o600);assert.equal(next.keys.publicKey,s.keys.publicKey);
});
test('gone endpoints are removed; transient delivery failure has bounded retry and survives restart',async t=>{
  const {service:s,state,store,desktop,options}=fixture(t);const sub=subscription();s.subscribe(sub);s.watch(id,state.history);state.history={...state.history,latestTurnStatus:'failed'};s.watch(id,state.history);
  state.error={statusCode:503};await s.deliver();assert.equal(state.sends.length,1);await s.deliver();assert.equal(state.sends.length,1);
  const next=new Notifications(store,desktop,options);state.now+=31000;state.error={statusCode:410};await next.deliver();assert.equal(next.subscriptionState(sub.endpoint).enabled,false);next.stop();
});
test('Web Push payload is encrypted and VAPID authentication is included',t=>{
  const {service:s}=fixture(t),sub=subscription(),payload=JSON.stringify({body:'任务已完成'});
  const request=webpush.generateRequestDetails(sub,payload,{vapidDetails:{subject:'https://x.fangs.cc',...s.keys}});
  assert.equal(request.headers['Content-Encoding'],'aes128gcm');assert.ok(request.headers.Authorization);assert.ok(!request.body.includes(Buffer.from(payload)));
});
test('a fallback read cannot consume a new source revision and permanently lose the completion',async t=>{
 const {service:s,state,store}=fixture(t);s.subscribe(subscription());s.watch(id,{...state.history,runtime:'idle',latestTurnStatus:'completed'});
 store.sync({threads:[{id,title:'Fixture',archived:false,updatedAt:2000}],projects:[],sourceInfo:{}});
 s.watch(id,{source:'rollout',runtime:'idle'});state.history={source:'desktop',runtime:'idle',latestTurnId:'turn-2',latestTurnStatus:'completed'};state.now+=11000;
 await s.tick();assert.equal(state.sends.length,1);assert.equal(JSON.parse(state.sends[0][1]).body,'任务已完成');
});
test('failed reads rotate so a fifth tracked task is not starved',async t=>{
 const {service:s,state,store}=fixture(t);s.subscribe(subscription());
 const ids=Array.from({length:5},(_,i)=>`task-${i}`);store.sync({threads:ids.map(id=>({id,title:id,archived:false,updatedAt:1000})),projects:[],sourceInfo:{}});
 for(const id of ids)s.watch(id,state.history);
 const reads=[];s.desktop={history:async id=>{reads.push(id);throw Error('offline');}};
 state.now+=11000;await s.tick();state.now+=11000;await s.tick();assert.ok(reads.includes('task-4'));
});
test('an approval handled on another client cancels its pending notification',async t=>{
 const {service:s,state}=fixture(t);s.subscribe(subscription());s.watch(id,state.history);s.watch(id,{...state.history,pendingRequests:[{key:'approval'}]});
 s.watch(id,state.history);await s.deliver();assert.equal(state.sends.length,0);
});
test('attention retries re-read the owner and do not deliver an already resolved request',async t=>{
 const {service:s,state}=fixture(t);s.subscribe(subscription());s.watch(id,state.history);state.history={...state.history,pendingRequests:[{key:'approval'}]};s.watch(id,state.history);
 state.error={statusCode:503};await s.deliver();assert.equal(state.sends.length,1);state.history={...state.history,pendingRequests:[]};state.now+=31000;state.error=null;
 await s.deliver();assert.equal(state.sends.length,1);
});

test('rotating the Pocket passphrase revokes notification endpoints and pending deliveries',t=>{
 const {service:s,state,store}=fixture(t);const auth=new AccessControl(store.directory,store.db);s.subscribe(subscription());s.watch(id,state.history);s.watch(id,{...state.history,latestTurnStatus:'completed'});
 auth.setPassphrase('new-private-test-passphrase');assert.equal(s.devices().length,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM push_deliveries').get().n,0);
});
test('a send accepted before any browser history read is followed through completion',async t=>{
 const {service:s,state}=fixture(t);s.subscribe(subscription());s.followSubmission(id,'turn-1');
 state.history={source:'desktop',runtime:'idle',latestTurnId:'turn-1',latestTurnStatus:'completed',pendingRequests:[]};state.now+=11000;
 await s.tick();assert.equal(state.sends.length,1);assert.equal(JSON.parse(state.sends[0][1]).body,'任务已完成');
});
test('following an accepted send retains pending approval state until the owner resolves it',t=>{
 const {service:s,state,store}=fixture(t);s.subscribe(subscription());s.watch(id,{...state.history,pendingRequests:[{key:'pending'}]});s.followSubmission(id,'turn-1');
 assert.deepEqual(JSON.parse(store.db.prepare('SELECT state FROM push_watches WHERE thread_id=?').get(id).state).requests,['pending']);
});
test('direct and queued HTTP sends register notification tracking without opening history',async t=>{
 const {makeApp}=await import('../server/index.mjs');
 const directory=mkdtempSync(join(tmpdir(),'pocket-send-watch-'));
 const app=makeApp({dataDir:directory,readSource:()=>({threads:[{id,title:'Fixture',archived:false}],projects:[],sourceInfo:{}}),
  notifications:{send:async()=>{}},desktopRequest:async p=>p.operation==='history'?{ok:true,source:'desktop',runtime:'active',canSend:true,messages:[]}:{ok:true,turnId:'accepted-turn'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));rmSync(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`,authorization=`Bearer ${app.auth.localToken}`;
 const catalog=await fetch(base+'/api/catalog',{headers:{Authorization:authorization}}).then(r=>r.json());
 const post=(path,data)=>fetch(base+path,{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json','X-Navigator-Token':catalog.csrfToken},body:JSON.stringify(data)}).then(r=>r.json());
 await post('/api/notifications/subscription',subscription());
 const read=()=>JSON.parse(app.store.db.prepare('SELECT state FROM push_watches WHERE thread_id=?').get(id).state);
 const rid='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
 assert.equal((await post(`/api/tasks/${id}/messages`,{requestId:rid,text:'Direct'})).status,'accepted');assert.equal(read().turn,'accepted-turn');
 app.store.db.prepare('DELETE FROM push_watches').run();
 const qid='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
 assert.equal((await post(`/api/tasks/${id}/messages`,{requestId:qid,text:'Queued',enqueue:true})).status,'queued');
 assert.equal((await post(`/api/tasks/${id}/outbox/${qid}/send`,{expectedRevision:0})).status,'accepted');assert.equal(read().turn,'accepted-turn');
});
