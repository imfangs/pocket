import test from 'node:test';
import assert from 'node:assert/strict';
import { displayConversation, displayMessages } from '../src/transcript.ts';
const message=(id,text=id)=>({id,role:'assistant',text});
test('a complete native prefix replaces a stale partial transcript boundary',()=>{
 const history={source:'desktop',messages:[message('old'),message('latest')],hasMore:false};
 const transcript={source:'rollout',messages:[message('latest')],hasMore:true};
 const result=displayConversation(history,transcript);assert.equal(result.hasMore,false);
 assert.deepEqual(result.messages.map(({id,text})=>({id,text})),history.messages.map(({id,text})=>({id,text})));
 assert.deepEqual(displayMessages(history,transcript),result.messages);
});
test('a partial native prefix remains partial when a saved tail is complete',()=>{
 const history={source:'desktop',messages:[message('latest')],hasMore:true};
 const transcript={source:'rollout',messages:[message('earlier'),message('latest')],hasMore:false};
 assert.equal(displayConversation(history,transcript).hasMore,true);
});
test('the boundary follows the selected branch and absent source',()=>{
 const history={source:'desktop',messages:[message('old')],hasMore:true,turnTiming:{turnId:'a',startedAt:1}};
 const transcript={source:'rollout',messages:[message('new')],hasMore:false,turnTiming:{turnId:'b',startedAt:2}};
 assert.equal(displayConversation(history,transcript).hasMore,false);
 assert.equal(displayConversation(null,{...transcript,hasMore:true}).hasMore,true);
 assert.equal(displayConversation({...history,hasMore:false},null).hasMore,false);
});
test('frontend message limits correctly retain the earlier-content boundary',()=>{
 const history={source:'desktop',messages:Array.from({length:81},(_,i)=>message(String(i))),hasMore:false};
 const transcript={source:'rollout',messages:[message('80')],hasMore:false};
 const result=displayConversation(history,transcript);
 assert.equal(result.messages.length,80);assert.equal(result.hasMore,true);
});

test('the total text budget reports a partial earlier message, unlike a single-message cap',()=>{
 for(const [count,characters,expectedMore,firstLength] of [[7,24000,true,16000],[1,24001,false,24000]]){
  const messages=Array.from({length:count},(_,i)=>message(`message-${i}`,'x'.repeat(characters)));
  const result=displayConversation({source:'desktop',messages,hasMore:false},
   {source:'rollout',messages:structuredClone(messages),hasMore:false});
  assert.equal(result.messages.length,count);
  assert.equal(result.messages[0].text.length,firstLength);
  assert.equal(result.messages[0].truncated,true);
  assert.equal(result.hasMore,expectedMore);
 }
});

test('a later native response cannot remove the saved boundary at the same visible prefix',()=>{
 const messages=Array.from({length:80},(_,i)=>message(`message-${i}`));
 const transcript={source:'rollout',messages,hasMore:true};
 const history={source:'desktop',messages:structuredClone(messages),hasMore:false};
 const before=structuredClone(history);
 assert.equal(displayConversation(null,transcript).hasMore,true);
 const merged=displayConversation(history,transcript);
 assert.equal(merged.hasMore,true);
 assert.deepEqual(merged.messages.map(m=>m.id),messages.map(m=>m.id));
 assert.deepEqual(history,before);
});

test('a related saved prefix can expose omitted older messages without replacing the live body',()=>{
 const history={source:'desktop',messages:[message('anchor'),message('latest')],hasMore:false};
 const transcript={source:'rollout',messages:[message('older'),message('anchor'),message('latest')],hasMore:false};
 const merged=displayConversation(history,transcript);
 assert.equal(merged.hasMore,true);
 assert.deepEqual(merged.messages.map(m=>m.id),['anchor','latest']);
});

test('a matching completed turn preserves its relevant saved earlier-history boundary',()=>{
 const history={source:'desktop',messages:[{...message('native-user'),role:'user',turnId:'turn'}],hasMore:false,
  turnTiming:{turnId:'turn',status:'inProgress'}};
 const transcript={source:'rollout',messages:[{...message('saved-user'),role:'user',turnId:'turn'},
  {...message('final'),turnId:'turn',phase:'final_answer'}],hasMore:true,turnTiming:{turnId:'turn',status:'completed'}};
 const displayed=displayConversation(history,transcript);
 assert.equal(displayed.hasMore,true);
 assert.deepEqual(displayed.messages.map(m=>m.id),['saved-user','final']);
 const fullNative={...history,messages:[{...message('previous'),turnId:'previous'},...history.messages]};
 assert.equal(displayConversation(fullNative,transcript).hasMore,false,
  'an already complete native prefix still covers a shorter saved current turn');
});

test('unrelated, conflicting or reordered saved branches cannot donate an earlier-history boundary',()=>{
 const pairs=[
  [[message('native')],[message('saved')]],
  [[message('anchor'),message('native-tail')],[message('anchor'),message('saved-tail')]],
  [[message('a'),message('b'),message('c')],[message('a'),message('c'),message('b')]],
  [[{...message('same'),turnId:'native-turn'}],[{...message('same'),turnId:'saved-turn'}]],
 ];
 for(const [live,saved] of pairs){
  const displayed=displayConversation({source:'desktop',messages:live,hasMore:false},
   {source:'rollout',messages:saved,hasMore:true});
  assert.equal(displayed.hasMore,false);
 }
});
