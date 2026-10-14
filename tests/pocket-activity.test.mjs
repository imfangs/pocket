import test from 'node:test';
import assert from 'node:assert/strict';
import {readPocketActivity, savePocketActivity, recordPocketVisit, rememberPocketCreations} from '../src/pocketActivity.ts';

const now=2_000_000_000_000, day=86400000;
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
test('only an explicit visit records a click, without importing thread text or changing prior entries',()=>{
 const original=new Map();const next=recordPocketVisit(original,id(1),now);
 assert.equal(original.size,0);assert.equal(next.get(id(1)).visitedAt,now);
 assert.equal(rememberPocketCreations(next,[],now+1000),next);
 assert.equal(recordPocketVisit(next,'not-a-thread',now),next);
});
test('creation evidence comes from verified Pocket receipts and is not renewed by polling or recovery',()=>{
 const operation={operation:'create',status:'succeeded',threadId:id(1),createdAt:now-1000};
 const first=rememberPocketCreations(new Map(),[operation],now);
 assert.equal(first.get(id(1)).createdAt,now-1000);
 assert.equal(rememberPocketCreations(first,[operation],now+1000),first);
 assert.equal(rememberPocketCreations(first,[{...operation,createdAt:now}],now),first);
 for(const bad of [{...operation,operation:'archive'},{...operation,status:'unknown'},{...operation,createdAt:undefined}])
   assert.equal(rememberPocketCreations(new Map(),[bad],now).size,0);
 assert.equal(rememberPocketCreations(new Map(),[{...operation,status:'unknown',creationStatus:'created'}],now).size,1);
});
test('stored interests contain only bounded ID/timestamp metadata and tolerate damaged/private storage',()=>{
 let saved;const storage={getItem:()=>saved,setItem:(_,value)=>{saved=value;}};
 const entries=Array.from({length:230},(_,n)=>[id(n),{visitedAt:now-n,query:'never retain this',title:'private title'}]);
 entries.push([id(999),{visitedAt:now-91*day}]);saved=JSON.stringify(entries);
 const read=readPocketActivity(storage,now);assert.equal(read.size,200);assert.ok(!read.has(id(999)));
 savePocketActivity(read,storage);assert.doesNotMatch(saved,/query|title|private|never retain/);
 assert.equal(readPocketActivity({getItem:()=>'{broken'},now).size,0);
 assert.doesNotThrow(()=>savePocketActivity(read,{setItem:()=>{throw Error('blocked');}}));
});
test('full recent-interest cache does not renew the ranking clock when an old creation is evicted again',()=>{
 const current=new Map(Array.from({length:200},(_,n)=>[id(n),{visitedAt:now-n}]));
 const operation={operation:'create',status:'succeeded',threadId:id(999),createdAt:now-day};
 assert.equal(rememberPocketCreations(current,[operation],now),current);
 assert.equal(rememberPocketCreations(current,[operation],now+1000),current);
 assert.equal(current.has(id(999)),false);
});
