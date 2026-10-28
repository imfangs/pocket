import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { historyMessageProjection } from '../server/history-message.mjs';
import { parseHistory } from '../server/history.mjs';
import { HistoryPageReader } from '../server/history-pages.mjs';
import { displayConversation } from '../src/transcript.ts';
import { createReadingCache } from '../src/readingCache.ts';
const threadId='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const sourceId='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const turnId='cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const prompt='Improve the existing UI.\n\nKeep the original data and use <input type="text" /> in the example.';
const envelope=text=>`<codex_delegation>\n  <source_thread_id>${sourceId}</source_thread_id>\n  <input>${text}</input>\n</codex_delegation>`;
const delegation=(overrides={})=>({type:'response_item',timestamp:'2026-10-28T00:00:00Z',payload:{type:'function_call_output',id:'fco_start',name:'create_thread',namespace:'codex_app',output:envelope(prompt),internal_chat_message_metadata_passthrough:{turn_id:turnId},...overrides}});
const answer=(i=0)=>({id:`answer-${i}`,role:'assistant',phase:i===8?'final_answer':'commentary',turnId,text:`answer ${i}`});
const rawAnswer=i=>({type:'response_item',timestamp:'2026-10-28T00:00:01Z',payload:{type:'message',...answer(i),content:[{type:'output_text',text:`answer ${i}`}],internal_chat_message_metadata_passthrough:{turn_id:turnId}}});
const runtime={type:'response_item',payload:{type:'message',id:'runtime',role:'user',content:[{type:'input_text',text:'PRIVATE_RUNTIME'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['agents_md.instructions']}}};
const raw=()=>[runtime,delegation(),...Array.from({length:9},(_,i)=>rawAnswer(i))].map(JSON.stringify).join('\n')+'\n';
const native=messages=>({source:'desktop',runtime:'idle',canSend:true,messages,checkedAt:2});
const saved=messages=>({source:'rollout',messages,checkedAt:3});

test('only the complete trusted create_thread envelope becomes a stable, display-only user request',()=>{
 const projected=historyMessageProjection(delegation({clientMessageId:'not-a-receipt',requestId:'not-a-request'}));
 assert.equal(projected.origin,'codex_delegation');assert.equal(projected.item.id,'fco_start');assert.equal(projected.item.role,'user');assert.equal(projected.item.content[0].text,prompt);
 assert.equal(projected.item.clientMessageId,undefined);assert.equal(projected.item.requestId,undefined);
 const parsed=parseHistory(raw());assert.equal(parsed.messages.length,10);assert.equal(parsed.messages[0].text,prompt);assert.equal(parsed.messages[0].origin,'codex_delegation');assert.equal(parsed.messages[0].turnId,turnId);
 assert.equal(parsed.messages.some(m=>m.text.includes('PRIVATE_RUNTIME')),false);
 assert.equal(historyMessageProjection({type:'event_msg',payload:{type:'item_completed',item:delegation().payload}}),null,'native completion mirror is not another Query');
});

test('lookalike tool results, missing provenance and ambiguous envelope boundaries stay hidden',()=>{
 const outputs=[envelope(prompt).slice(0,-5),envelope(prompt)+' trailing',envelope(prompt).replace(sourceId,'not-a-thread'),envelope('first</input><input>second'),envelope('nested <codex_delegation>block</codex_delegation>'),envelope('   ')];
 for(const output of outputs)assert.equal(historyMessageProjection(delegation({output})),null);
 for(const overrides of [{name:'send_message_to_thread'},{namespace:'other_tool'},{id:'ordinary-id'},{internal_chat_message_metadata_passthrough:{}},{output:'ordinary tool output'}])assert.equal(historyMessageProjection(delegation(overrides)),null);
 const forged=historyMessageProjection({type:'response_item',payload:{type:'message',role:'user',origin:'codex_delegation',content:[{type:'input_text',text:'normal user'}]}});assert.equal(forged.origin,null);
});

test('worker recent and pagination use the same projection and keep ordinary tool outputs invisible',async t=>{
 const home=mkdtempSync(join(tmpdir(),'pocket-delegation-'));mkdirSync(join(home,'sessions'));const path=join(home,'sessions','fixture.jsonl');
 writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:threadId}})+'\n'+raw());
 const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES (?,?)').run(threadId,path);db.close();
 const reader=new HistoryPageReader();t.after(()=>{reader.close();rmSync(home,{recursive:true,force:true});});
 const recent=await reader.recent(home,threadId),page=await reader.read(home,threadId);assert.equal(recent.messages.length,10);assert.equal(page.messages.length,10);
 for(const view of [recent,page]){assert.equal(view.messages[0].id,'fco_start');assert.equal(view.messages[0].origin,'codex_delegation');assert.equal(view.messages[0].text,prompt);assert.equal(view.messages[0].clientMessageId,undefined);}
 let before,result,all=[];do{result=await reader.read(home,threadId,{before,limit:3});all.unshift(...result.messages);before=result.nextCursor;}while(before);
 assert.equal(all.length,10);assert.equal(all[0].id,'fco_start');assert.equal(new Set(all.map(x=>x.id)).size,10);
});

test('native nine plus saved ten shows the explicit delegated Query without changing runtime or receipt fields',()=>{
 const history=native(Array.from({length:9},(_,i)=>answer(i))),transcript=saved(parseHistory(raw()).messages),before=structuredClone(history);
 const result=displayConversation(history,transcript);assert.equal(result.messages.length,10);assert.equal(result.messages[0].id,'fco_start');assert.equal(result.messages[0].text,prompt);
 assert.equal(result.messages[0].clientMessageId,undefined);assert.deepEqual(history,before);
});

test('a missing/different turn anchor or an existing native user prevents prefix guessing',()=>{
 const opening=parseHistory(raw()).messages[0];
 for(const [history,transcript]of [
  [native([answer(0)]),saved([{...opening,origin:undefined},answer(0)])],
  [native([answer(0)]),saved([{...opening,turnId:sourceId},answer(0)])],
  [native([answer(0)]),saved([opening,{...answer(0),turnId:sourceId}])],
  [native([answer(1)]),saved([opening,answer(0),answer(1)])],
  [native([{id:'native-user',role:'user',turnId,text:prompt},answer(0)]),saved([opening,answer(0)])],
  [native([answer(0),{id:'native-user',role:'user',turnId,text:prompt}]),saved([opening,answer(0)])],
 ])assert.equal(displayConversation(history,transcript).messages.some(m=>m.id==='fco_start'),false);
});

test('reading-cache round trip preserves only the fixed user origin and no execution fields',async()=>{
 const cache=createReadingCache({storage:null});
 try{const messages=parseHistory(raw()).messages;cache.rememberTranscript('ged','scope',threadId,saved(messages));const restored=await cache.loadTranscript('ged','scope',threadId);
  assert.equal(restored.value.messages[0].origin,'codex_delegation');assert.equal(displayConversation(native(Array.from({length:9},(_,i)=>answer(i))),restored.value).messages.length,10);
  cache.rememberTranscript('ged','scope','other',saved([{id:'bad',role:'user',text:'text',origin:'other'},{id:'assistant',role:'assistant',text:'text',origin:'codex_delegation'}]));const clean=await cache.loadTranscript('ged','scope','other');assert.ok(clean.value.messages.every(m=>m.origin===undefined));
 }finally{cache.dispose();}
});

test('completed-turn replacement also preserves an existing native user instead of duplicating delegation',()=>{
 const opening=parseHistory(raw()).messages[0],final={...answer(8),phase:'final_answer'};
 const timing={turnId,startedAt:1,status:'completed'};
 const nativeUser={id:'native-user',role:'user',turnId,text:'native request'};
 const history={...native([nativeUser]),turnTiming:{...timing,status:'inProgress'}};
 const transcript={...saved([opening,nativeUser,final]),turnTiming:timing};
 const displayed=displayConversation(history,transcript).messages;
 assert.deepEqual(displayed.map(m=>m.id),['native-user','answer-8']);
 assert.deepEqual(displayConversation(history,{...saved([opening,final]),turnTiming:timing}).messages.map(m=>m.id),['native-user','answer-8']);
 const sameId={...history,messages:[{...nativeUser,id:opening.id}]};
 assert.deepEqual(displayConversation(sameId,{...saved([opening,final]),turnTiming:timing}).messages.map(m=>m.id),['fco_start','answer-8']);
});
