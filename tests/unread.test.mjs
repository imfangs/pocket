import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {readUnreadState,parseRecordedTurnState,readRecordedTurnState} from '../server/unread.mjs';
import {readCodexSource} from '../server/source.mjs';
const hash=parts=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const identity=hash(['execution-storage','apikey']),host='local:'+hash(['local','local',null]);
const state=value=>({'electron-thread-read-state-v1':{version:1,unreadByIdentity:{[identity]:{[host]:value}}}});
const lines=rows=>rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
const event=(type,turn='t')=>({type:'event_msg',payload:{type,turn_id:turn}});
const temp=t=>{const p=mkdtempSync(join(tmpdir(),'pocket-unread-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;};
test('desktop unread namespace is selected exactly, without mixing accounts, hosts or migrated snapshots',()=>{
 const global=state(['current']);global['electron-thread-read-state-v1'].unreadByIdentity.other={elsewhere:['foreign']};global['electron-thread-read-state-v1'].unreadByIdentity[identity].other=['other-host'];
 global['electron-persisted-atom-state']={'unread-thread-ids-by-host-v1':{local:['old']}};
 assert.deepEqual([...readUnreadState(global,'apikey').ids],['current']);assert.equal(readUnreadState(global,'chatgpt').available,false);
 global['electron-thread-read-state-v1'].unreadByIdentity={};assert.deepEqual([...readUnreadState(global,'apikey').ids],[]);assert.equal(readUnreadState(global,'apikey').available,true);
 global['electron-thread-read-state-v1'].version=2;assert.equal(readUnreadState(global,'apikey').available,false);
 delete global['electron-thread-read-state-v1'];assert.deepEqual([...readUnreadState(global,'apikey').ids],['old']);
 assert.equal(readUnreadState(state(null),'apikey').available,false);
});
test('ended unread work is distinguished from started, unknown, compaction and late events from an older turn',()=>{
 assert.equal(parseRecordedTurnState(lines([event('task_started'),event('task_complete')])),'ended');
 assert.equal(parseRecordedTurnState(lines([event('task_complete','old'),event('task_started','new')])),'unconfirmed');
 assert.equal(parseRecordedTurnState(lines([event('task_complete','old'),event('task_started','new'),event('turn_aborted','old')])),'unconfirmed');
 assert.equal(parseRecordedTurnState(lines([{type:'compacted',payload:{message:'task_complete'}},{type:'response_item',payload:{type:'task_complete'}}])),'unknown');
 assert.equal(parseRecordedTurnState(lines([event('turn_started'),event('turn_complete')])),'ended');
 assert.equal(parseRecordedTurnState(lines([event('task_complete')])+'{"partial":'),'unknown');
});
test('bounded tail reads validate task identity and path, and invalidate cached state when the file grows',t=>{
 const home=temp(t);mkdirSync(join(home,'sessions'));const file=join(home,'sessions','rollout.jsonl');
 writeFileSync(file,lines([{type:'session_meta',payload:{id:'one'}},event('task_complete')]));
 assert.equal(readRecordedTurnState(home,'one',file),'ended');assert.equal(readRecordedTurnState(home,'other',file),'unknown');
 appendFileSync(file,lines([event('task_started','next')]));assert.equal(readRecordedTurnState(home,'one',file),'unconfirmed');
 appendFileSync(file,lines([event('task_complete','next')]));assert.equal(readRecordedTurnState(home,'one',file),'ended');
 const outside=join(home,'outside.jsonl');writeFileSync(outside,readFileSync(file));assert.equal(readRecordedTurnState(home,'one',outside),'unknown');
 symlinkSync(outside,join(home,'sessions','escape.jsonl'));assert.equal(readRecordedTurnState(home,'one',join(home,'sessions','escape.jsonl')),'unknown');
});
test('source import exposes only ended unread top-level tasks and leaves all Codex records untouched',t=>{
 const home=temp(t);mkdirSync(join(home,'sessions'));const dbPath=join(home,'state_5.sqlite');const db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT,rollout_path TEXT,thread_source TEXT,agent_path TEXT)');
 for(const [id,unread,status,archived,child] of [['done',true,'task_complete',0,false],['running',true,'task_started',0,false],['read',false,'task_complete',0,false],['archived',true,'task_complete',1,false],['child',true,'task_complete',0,true]]){
  const file=join(home,'sessions',id+'.jsonl');writeFileSync(file,lines([{type:'session_meta',payload:{id}},event(status)]));
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,'/fixture',archived,1,2,'app',file,child?'subagent':'user',child?'/root/sub':null);
 }
 db.close();const global={...state(['done','running','archived','child']),'pinned-thread-ids':[]};const globalPath=join(home,'.codex-global-state.json');writeFileSync(globalPath,JSON.stringify(global));writeFileSync(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey'}));
 const before=[dbPath,globalPath].map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));
 const result=readCodexSource(home);assert.deepEqual(result.threads.filter(t=>t.needsInput).map(t=>t.id),['done']);assert.equal(result.sourceInfo.unread.pending,1);assert.equal(result.threads.find(t=>t.id==='read').hasUnreadTurn,false);
 assert.deepEqual([dbPath,globalPath].map(p=>createHash('sha256').update(readFileSync(p)).digest('hex')),before);
});
