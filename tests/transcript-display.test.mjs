import test from 'node:test';
import assert from 'node:assert/strict';
import { displayMessages } from '../src/transcript.ts';
import { rememberHistory, rememberTranscript } from '../src/conversationFeed.ts';
const msg=(id,text=id,extra={})=>({id,role:'assistant',text,...extra});
const live=messages=>({source:'desktop',runtime:'active',canSend:true,messages,checkedAt:1});
const saved=messages=>({source:'rollout',messages,checkedAt:2});

test('a newly persisted reply remains visible when an older desktop snapshot arrives late',()=>{
  const transcript=saved([msg('anchor'),msg('new','new reply')]);
  assert.deepEqual(displayMessages(null,transcript).map(m=>m.id),['anchor','new']);
  const history=live([msg('older'),msg('anchor')]),before=structuredClone(history);
  assert.deepEqual(displayMessages(history,transcript).map(m=>m.id),['older','anchor','new']);
  assert.deepEqual(history,before);
});
test('live streaming stays ahead, while a persisted extension completes the same message without duplication',()=>{
  assert.deepEqual(displayMessages(live([msg('anchor'),msg('stream','abc')]),saved([msg('anchor')])).map(m=>m.id),['anchor','stream']);
  let result=displayMessages(live([msg('same','abc',{clientMessageId:'receipt'})]),saved([msg('same','abcdef',{phase:'final_answer',turnDurationMs:12})]));
  assert.equal(result.length,1);assert.equal(result[0].text,'abcdef');assert.equal(result[0].clientMessageId,'receipt');assert.equal(result[0].turnDurationMs,12);
  result=displayMessages(live([msg('same','corrected')]),saved([msg('same','different old text')]));assert.equal(result[0].text,'corrected');
  assert.deepEqual(displayMessages(live([msg('anchor'),msg('branch-a')]),saved([msg('anchor'),msg('branch-b')])).map(m=>m.id),['anchor','branch-a']);
});
test('different user message IDs do not hide the completed first turn and newer turns require positive ordering',()=>{
  const history={...live([msg('native-user','query',{role:'user',turnId:'one'})]),turnTiming:{turnId:'one',startedAt:100,status:'inProgress'}};
  const transcript={...saved([msg('recorded-user','query',{role:'user',turnId:'one'}),msg('final','reply',{phase:'final_answer',turnId:'one'})]),turnTiming:{turnId:'one',startedAt:99,status:'completed'}};
  assert.equal(displayMessages(history,transcript).at(-1).id,'final');
  assert.equal(displayMessages(history,{...transcript,turnTiming:{turnId:'two',startedAt:200,status:'inProgress'}}).at(-1).id,'final');
  assert.equal(displayMessages(history,{...transcript,turnTiming:null}).at(-1).id,'native-user');
  const withOlder={...history,messages:[msg('older','previous',{turnId:'previous'}),...history.messages]};
  const withAnchor={...transcript,messages:[msg('older','previous',{turnId:'previous'}),...transcript.messages]};
  assert.deepEqual(displayMessages(withOlder,withAnchor).map(m=>m.id),['older','recorded-user','final']);
});
test('transcript caching preserves reading position without inventing live permissions; merged history stays bounded',()=>{
  const cache=new Map();rememberTranscript(cache,'task',saved([msg('one')]));assert.equal(cache.get('task').history,undefined);
  cache.get('task').scrollTop=321;cache.get('task').nearBottom=false;rememberHistory(cache,'task',live([msg('one')]));
  assert.equal(cache.get('task').transcript.messages[0].id,'one');assert.equal(cache.get('task').scrollTop,321);
  for(let i=0;i<12;i++)rememberTranscript(cache,String(i),saved([]));assert.equal(cache.size,10);
  const result=displayMessages(live([msg('anchor')]),saved([msg('anchor'),...Array.from({length:100},(_,i)=>msg(String(i),'x'.repeat(3000)))]));
  assert.ok(result.length<=80);assert.ok(result.reduce((sum,m)=>sum+m.text.length,0)<=160000);
});

test('an async question marked final_answer cannot replace the whole live turn as a final reply', () => {
  const history={...live([msg('native-user','query',{role:'user',turnId:'one'}),msg('work','Still working',{turnId:'one',phase:'commentary'})]),turnTiming:{turnId:'one',startedAt:1,status:'inProgress'}};
  const transcript={...saved([msg('saved-user','query',{role:'user',turnId:'one'}),msg('question','Choose A or B',{turnId:'one',phase:'final_answer',isQuestion:true})]),turnTiming:{turnId:'one',startedAt:1,status:'completed'}};
  assert.deepEqual(displayMessages(history,transcript).map(m=>m.id),['native-user','work']);
});
