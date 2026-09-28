import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {NavigatorStore} from '../server/store.mjs';import {DesktopService} from '../server/desktop.mjs';
import {readableQuestionReply} from '../src/questionReply.ts';
const id='aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',rid='bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',key='a'.repeat(64);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'pocket-question-'));const store=new NavigatorStore(dir);store.sync({threads:[{id,title:'Test',archived:false}],projects:[],sourceInfo:{}});
 const state={calls:[],result:{ok:true},messages:[]};const request=async p=>{if(p.operation==='history')return {ok:true,source:'desktop',messages:state.messages,asyncQuestions:[{key,title:'Choose',options:['A','B']}],canSend:true};state.calls.push(p);return state.result;};const service=new DesktopService(store,'/fixture',request);
 t.after(()=>{service.stopQueue();store.close();rmSync(dir,{recursive:true,force:true});});return {service,state,store,request};}
test('async answers are immediate, deduplicated and do not modify the ordinary outbox',async t=>{const {service:s,state}=fixture(t);
 await s.send(id,{requestId:'cccccccc-cccc-7ccc-8ccc-cccccccccccc',text:'Later',enqueue:true});
 assert.equal((await s.answer(id,key,{requestId:rid,text:'B'})).status,'accepted');
 assert.equal((await s.answer(id,key,{requestId:rid,text:'B'})).status,'accepted');
 assert.equal(state.calls.length,1);assert.equal(state.calls[0].operation,'answer');assert.equal(state.calls[0].delivery,'now');assert.equal(s.outbox(id).length,1);
 await assert.rejects(s.answer(id,key,{requestId:rid,text:'A'}),e=>e.status===409);
});
test('uncertain answers survive a restart and remain held until exact original-message read-back',async t=>{const {service:s,state,store,request}=fixture(t);state.result={ok:false,sent:null};
 assert.equal((await s.answer(id,key,{requestId:rid,text:'B'})).status,'unknown');
 const next=new DesktopService(store,'/fixture',request);next.startQueue();next.stopQueue();
 await assert.rejects(next.answer(id,key,{requestId:'cccccccc-cccc-7ccc-8ccc-cccccccccccc',text:'B'}),e=>e.status===409);
 state.messages=[{role:'user',clientMessageId:rid,turnId:'t',text:'B'}];await next.history(id);assert.equal(next.getReceipt(id,rid).status,'accepted');assert.equal(state.calls.length,1);
});
test('question replies display readable answers without protocol markup; malformed text is preserved',()=>{
 const value=[{questionItemId:'q',question:'方向？',answer:'B'}];const text='<send_user_message_question_reply>\n'+JSON.stringify(value)+'\n</send_user_message_question_reply>';
 assert.equal(readableQuestionReply(text),'回答：方向？\n\nB');assert.equal(readableQuestionReply('<send_user_message_question_reply>oops</send_user_message_question_reply>'),'<send_user_message_question_reply>oops</send_user_message_question_reply>');
});
