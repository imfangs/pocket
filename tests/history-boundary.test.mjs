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
