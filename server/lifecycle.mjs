import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './store.mjs';
import { runBridge } from './bridge-process.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active=new Set(['pending','waiting','unknown']);
const safeCode=code=>typeof code==='string'&&/^[a-z0-9_]{1,100}$/.test(code)?code:null;
const planOf=row=>{try{return JSON.parse(row.plan||'{}')||{};}catch{return {};}};
const initialMessageId=id=>{
  const hash=digest(['pocket.initial-query.v1',id]);
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${((parseInt(hash[16],16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
};

function nativeRequest(script,payload) {
  const config=JSON.parse(readFileSync(new URL('../config/desktop-bridge.json',import.meta.url),'utf8'));
  return runBridge(payload,{command:config.python,args:[fileURLToPath(new URL(`../bin/${script}`,import.meta.url))],timeoutMs:45000});
}

export function creationLocations(store,codexHome) {
  const candidates=new Map(), projects=[], paths=new Map();
  const canonicalPath=path=>{
    if(paths.has(path))return paths.get(path);
    let cwd=null;
    try { if(typeof path==='string'&&path.startsWith('/')&&statSync(path).isDirectory())cwd=realpathSync(path); }catch{}
    paths.set(path,cwd);return cwd;
  };
  let db;
  try {
    db=new DatabaseSync(join(codexHome,'state_5.sqlite'),{readOnly:true});
    for(const row of db.prepare('SELECT p.id,p.name,r.path FROM projects p JOIN project_roots r ON r.project_id=p.id ORDER BY p.name,r.position').all())
      if(uuid.test(row.id))projects.push(row);
  } catch { /* Recent verified directories remain usable without project metadata. */ }
  finally { db?.close(); }
  const add=(path,label,projectId=null,projectName=null)=>{
    const cwd=canonicalPath(path);
    if(!cwd)return;
    const id=digest([cwd,projectId]);
    if(!candidates.has(id))candidates.set(id,{id,label:String(label||cwd).slice(0,220),cwd,projectId,projectName});
    return cwd;
  };
  const projectPaths=new Set();
  for(const p of projects){const cwd=add(p.path,p.name,p.id,p.name);if(cwd)projectPaths.add(cwd);}
  const catalog=store.catalog();
  for(const project of catalog.projects)for(const path of project.paths||[])
    if(!projectPaths.has(canonicalPath(path)))add(path,project.name);
  for(const thread of [...catalog.threads].sort((a,b)=>b.updatedAt-a.updatedAt))
    if(!thread.missing&&!projectPaths.has(canonicalPath(thread.cwd)))add(thread.cwd,thread.cwd);
  return [...candidates.values()].slice(0,200);
}

export class LifecycleService {
  constructor(store,desktop,codexHome,sync,options={}) {
    Object.assign(this,{store,desktop,codexHome,sync});
    this.locations=options.locations||(()=>creationLocations(store,codexHome));
    this.create=options.create||(payload=>nativeRequest('create-thread.py',payload));
    this.archive=options.archive||(payload=>nativeRequest('archive-thread.py',payload));
    this.tickMs=options.tickMs??15000;
    this.running=new Map();this.blocked=new Set();this.blockedOwners=new Map();this.stopped=false;
    this.receiptDirectory=join(store.directory,'lifecycle-receipts');
    mkdirSync(this.receiptDirectory,{recursive:true,mode:0o700});
    store.db.exec(`CREATE TABLE IF NOT EXISTS lifecycle_operations(
      id TEXT PRIMARY KEY,operation TEXT NOT NULL,thread_id TEXT,input_hash TEXT NOT NULL,
      payload TEXT NOT NULL,status TEXT NOT NULL,code TEXT,plan TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    store.db.exec("UPDATE lifecycle_operations SET status='unknown',code='operation_interrupted' WHERE status='pending'");
    this.refreshBlocked();
    desktop.lifecycleBlocked=id=>this.blocked.has(id);
  }
  refreshBlocked() {
    const next=new Set(),owners=new Map();
    for(const row of this.store.db.prepare("SELECT id,operation,thread_id,plan FROM lifecycle_operations WHERE status IN('pending','waiting','unknown') AND thread_id IS NOT NULL").all()){
      // A verified, stopped creator no longer owns the native thread. Its
      // remaining first-message handoff must use the ordinary desktop queue.
      if(row.operation==='create'&&planOf(row).creationStatus==='created')continue;
      next.add(row.thread_id);owners.set(row.thread_id,row.id);
      try { for(const id of JSON.parse(row.plan||'{}').threadIds||[]){next.add(id);owners.set(id,row.id);} }catch{}
    }
    for(const id of next)if(!this.blocked.has(id))this.desktop.suspendConnection?.(id);
    const changed=next.size!==this.blocked.size||[...next].some(id=>!this.blocked.has(id));
    this.blocked=next;this.blockedOwners=owners;
    if(changed)this.onBlockedChange?.();
  }
  options() { return {available:true,locations:this.locations()}; }
  row(id) {
    if(!uuid.test(id))throw new AppError('操作编号无效',400);
    const row=this.store.db.prepare('SELECT * FROM lifecycle_operations WHERE id=?').get(id);
    if(!row)throw new AppError('找不到这次操作',404);
    return row;
  }
  receipt(row) {
    const result={requestId:row.id,operation:row.operation,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at};
    if(row.code)result.code=row.code;
    if(row.thread_id){
      result.threadId=row.thread_id;
      if(row.status==='succeeded'){
        try { const thread=this.store.thread(row.thread_id);result.thread={...thread,...this.store.annotation(row.thread_id,thread)}; }catch{}
      }
    }
    const plan=planOf(row);
    if(Number.isInteger(plan.descendantCount))result.descendantCount=plan.descendantCount;
    if(row.operation==='create'){
      if(plan.creationStatus==='created'||row.status==='succeeded')result.creationStatus='created';
      const payload=JSON.parse(row.payload);
      if(payload.initialQuery!==undefined)result.initialMessage=this.initialMessage(row);
    }
    return result;
  }
  initialMessage(row) {
    const requestId=initialMessageId(row.id);
    const saved=this.store.db.prepare('SELECT thread_id,status,code FROM dispatches WHERE id=?').get(requestId);
    if(saved&&saved.thread_id!==row.thread_id)return {requestId,status:'unknown',code:'initial_message_conflict'};
    if(saved)return {requestId,status:saved.status,...(safeCode(saved.code)?{code:saved.code}:{})};
    return {requestId,status:planOf(row).initialMessagePersisted?'unknown':'not_queued',
      ...(planOf(row).initialMessagePersisted?{code:'initial_message_receipt_missing'}:{})};
  }
  list() {
    // Waiting/unknown requests cannot fall out of the recovery view behind newer completed work.
    const rows=this.store.db.prepare("SELECT * FROM lifecycle_operations ORDER BY CASE WHEN status IN('pending','waiting','unknown') THEN 0 ELSE 1 END,created_at DESC LIMIT 100").all();
    return {operations:rows.map(row=>this.receipt(row))};
  }
  reserve(id,operation,threadId,payload) {
    if(typeof id!=='string'||!uuid.test(id))throw new AppError('需要有效的请求编号',400);
    const hash=digest([operation,threadId,payload]);
    const old=this.store.db.prepare('SELECT * FROM lifecycle_operations WHERE id=?').get(id);
    if(old){if(old.input_hash!==hash)throw new AppError('请求编号已用于另一项操作',409);return {row:old,created:false};}
    if(threadId&&this.blocked.has(threadId))throw new AppError('此会话已有待完成操作，请先核对或取消',409);
    const now=Date.now();
    this.store.db.prepare("INSERT INTO lifecycle_operations VALUES(?,?,?,?,?,'pending',NULL,NULL,?,?)").run(id,operation,threadId,hash,JSON.stringify(payload),now,now);
    this.refreshBlocked();
    return {row:this.row(id),created:true};
  }
  update(id,status,code=null,extra={}) {
    if(this.stopped)return;
    const row=this.row(id);
    this.store.db.prepare('UPDATE lifecycle_operations SET status=?,code=?,thread_id=?,plan=?,updated_at=? WHERE id=?')
      .run(status,safeCode(code),extra.threadId??row.thread_id,extra.plan===undefined?row.plan:JSON.stringify(extra.plan),Date.now(),id);
    this.refreshBlocked();
  }
  work(id,task) {
    if(this.running.has(id))return this.running.get(id);
    const promise=Promise.resolve().then(task).catch(()=>{
      if(!this.stopped)this.update(id,'unknown','operation_unconfirmed');
    }).finally(()=>this.running.delete(id));
    this.running.set(id,promise);return promise;
  }
  startCreate(input) {
    if(!input||Object.keys(input).some(k=>!['requestId','locationId','name','initialQuery'].includes(k))||typeof input.locationId!=='string'||
      (input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>220||input.name.includes('\0'))))
      throw new AppError('请选择工作目录；名称最多220字',400);
    if(input.initialQuery!==undefined&&(typeof input.initialQuery!=='string'||!input.initialQuery.trim()||input.initialQuery.length>16000))
      throw new AppError('首条消息需为1–16000字',400);
    // Use the original validated payload for an idempotent retry even if locations subsequently change.
    const existing=typeof input.requestId==='string'?this.store.db.prepare('SELECT * FROM lifecycle_operations WHERE id=?').get(input.requestId):null;
    const selected=this.locations().find(location=>location.id===input.locationId);
    if(!selected&&!existing)throw new AppError('工作目录已变化，请刷新后重新选择',409);
    const payload={locationId:input.locationId,...(input.name===undefined?{}:{name:input.name.trim()}),
      ...(input.initialQuery===undefined?{}:{initialQuery:input.initialQuery.trim()})};
    const oldPayload=existing?JSON.parse(existing.payload):null;
    const full={...payload,cwd:selected?.cwd??oldPayload?.cwd,...((selected?.projectId??oldPayload?.projectId)?{projectId:selected?.projectId??oldPayload?.projectId}:{})};
    const reserved=this.reserve(input.requestId,'create',null,full);
    if(reserved.created)void this.work(input.requestId,()=>this.createStep(input.requestId));
    return this.receipt(reserved.row);
  }
  async createStep(id,recover=false) {
    const row=this.row(id),payload=JSON.parse(row.payload),receiptPath=join(this.receiptDirectory,id+'.json');
    // Once native creation was independently verified, recovery must never run
    // the empty-thread creator again: the first message may already be running.
    if(planOf(row).creationStatus==='created'){await this.finishCreate(id);return;}
    if(recover&&!existsSync(receiptPath))return;
    const result=await this.create({requestId:id,codexHome:this.codexHome,cwd:payload.cwd,receiptPath,
      ...(payload.name?{name:payload.name}:{}),...(payload.projectId?{projectId:payload.projectId}:{})});
    if(this.stopped)return;
    if(result.status==='created'&&result.verified===true&&result.processStopped===true&&uuid.test(result.threadId)){
      if(row.thread_id&&row.thread_id!==result.threadId){this.update(id,'unknown','create_thread_mismatch');return;}
      this.update(id,'pending',null,{threadId:result.threadId,plan:{...planOf(row),creationStatus:'created'}});
      await this.finishCreate(id);
    } else this.update(id,['rejected','unavailable'].includes(result.status)||(!result.status&&result.sent===false)?'rejected':'unknown',result.code||'create_unconfirmed',
      uuid.test(result.threadId||'')?{threadId:result.threadId}:{});
  }
  async finishCreate(id) {
    const row=this.row(id),payload=JSON.parse(row.payload),plan=planOf(row);
    if(this.stopped||!['pending','unknown'].includes(row.status)||plan.creationStatus!=='created'||!row.thread_id)return;
    this.sync();this.store.thread(row.thread_id);
    if(payload.initialQuery===undefined){this.update(id,'succeeded');return;}
    let message=this.initialMessage(row),attempted=false;
    if(message.status==='not_queued'){
      attempted=true;
      try {
        await this.desktop.send(row.thread_id,{requestId:message.requestId,text:payload.initialQuery,enqueue:true});
      } catch { /* Read the durable queue before deciding whether handoff failed. */ }
      if(this.stopped)return;
      message=this.initialMessage(row);
    }
    const queued=this.store.db.prepare('SELECT 1 FROM outgoing_messages WHERE id=? AND thread_id=?').get(message.requestId,row.thread_id);
    // An existing edited/cancelled queue entry remains the user's decision.
    // A bare pending/unknown dispatch without durable text is not replayable.
    const persisted=message.code!=='initial_message_conflict'&&(queued||message.status==='accepted'||message.status==='cancelled');
    if(!persisted){
      this.update(id,'unknown',message.status==='not_queued'?'initial_message_not_queued':message.code||'initial_message_unconfirmed');
      return;
    }
    this.update(id,'succeeded',null,{plan:{...plan,initialMessagePersisted:true}});
    if(!attempted&&message.status==='queued'){
      try { this.desktop.connectForSubmission(row.thread_id); }
      catch { /* The durable queue and its ordinary retry controls remain intact. */ }
    }
  }
  archiveBlock(id) {
    if(this.renamePending?.(id))return 'rename_in_progress';
    if(this.desktop.outbox(id).length)return 'outbox_not_empty';
    if(this.desktop.sending.has(id)||this.desktop.queueReservations.has(id)||this.desktop.stops.pending(id)||this.desktop.compactionPending(id))return 'operation_in_progress';
    const pending=this.store.db.prepare("SELECT id FROM request_responses WHERE thread_id=? AND status='pending' LIMIT 1").get(id);
    return pending?'operation_in_progress':null;
  }
  startArchive(id,input) {
    const thread=this.store.thread(id);
    if(!input||Object.keys(input).some(k=>!['requestId','archived'].includes(k))||typeof input.archived!=='boolean')
      throw new AppError('需要有效的归档目标状态',400);
    // Refuse before reserve() suspends an owner. Renaming alone must never
    // interrupt the original turn or its message queue.
    if(this.renamePending?.(id))throw new AppError('此会话有未确认的重命名，请先核对结果',409);
    const blocker=input.archived?this.archiveBlock(id):null;
    const reserved=this.reserve(input.requestId,input.archived?'archive':'restore',id,{archived:input.archived});
    if(reserved.created){
      if(thread.missing)this.update(input.requestId,'rejected','thread_missing');
      else if(!input.archived&&!thread.archived)this.update(input.requestId,'succeeded');
      else if(blocker)this.update(input.requestId,'rejected',blocker);
      else void this.work(input.requestId,()=>this.archiveStep(input.requestId));
    }
    return this.receipt(this.row(input.requestId));
  }
  async archiveStep(id) {
    const row=this.row(id),threadId=row.thread_id;
    if(this.stopped||!['pending','waiting'].includes(row.status))return;
    if(this.renamePending?.(threadId)){this.update(id,'rejected','rename_in_progress');return;}
    const desired=row.operation==='archive';
    const blocker=desired?this.archiveBlock(threadId):null;
    if(blocker){this.update(id,'rejected',blocker);return;}
    if(!desired){
      // Native restore affects only the named thread, not its archived subtree.
      this.update(id,'pending',null,{plan:{threadIds:[threadId],descendantCount:0}});
      const result=await this.archive({operation:'restore',threadId,codexHome:this.codexHome});
      this.archiveResult(id,false,result);return;
    }
    const inspected=await this.archive({operation:'inspect',threadId,codexHome:this.codexHome});
    if(this.stopped)return;
    if(inspected.status==='archived'&&inspected.verified===true){this.sync();this.update(id,'succeeded');return;}
    if(!['ready','waiting','archived'].includes(inspected.status)){
      this.update(id,'rejected',inspected.code||'thread_not_ready');return;
    }
    let plan;
    try{plan=JSON.parse(row.plan||'null');}catch{}
    if(plan&&plan.fingerprint!==inspected.fingerprint){this.update(id,'changed','thread_changed');return;}
    plan=plan||{fingerprint:inspected.fingerprint,descendantCount:inspected.descendantCount??0,threadIds:inspected.threadIds||[threadId]};
    for(const affected of plan.threadIds){
      if(affected===threadId)continue;
      if(this.blockedOwners.has(affected)&&this.blockedOwners.get(affected)!==id){this.update(id,'rejected','child_operation_in_progress');return;}
      if(this.archiveBlock(affected)){this.update(id,'rejected','child_operation_in_progress');return;}
    }
    this.update(id,inspected.status==='waiting'?'waiting':'pending',inspected.status==='waiting'?'writer_busy':null,{plan});
    if(inspected.status==='waiting')return;
    const result=await this.archive({operation:desired?'archive':'restore',threadId,codexHome:this.codexHome,expectedFingerprint:plan.fingerprint});
    this.archiveResult(id,desired,result);
  }
  archiveResult(id,desired,result) {
    if(this.stopped)return;
    if(result.status===(desired?'archived':'restored')&&result.verified===true){this.sync();this.update(id,'succeeded');}
    else if(result.status==='waiting')this.update(id,'waiting',result.code||'writer_busy');
    else if(result.status==='changed')this.update(id,'changed','thread_changed');
    else this.update(id,result.status==='blocked'||result.status==='unavailable'?'rejected':'unknown',result.code||'archive_unconfirmed');
  }
  async get(id) {
    const row=this.row(id);
    if(row.status==='unknown'&&!this.running.has(id)){
      await this.work(id,async()=>{
        if(row.operation==='create'){await this.createStep(id,true);return;}
        const state=await this.archive({operation:'inspect',threadId:row.thread_id,codexHome:this.codexHome,
          ...(row.operation==='restore'?{rootOnly:true}:{})});
        const achieved=row.operation==='archive'?state.status==='archived'&&state.verified===true:state.rootArchived===false;
        if(!this.stopped&&achieved){this.sync();this.update(id,'succeeded');}
      });
    }
    return this.receipt(this.row(id));
  }
  async cancel(id) {
    const row=this.row(id);
    if(this.running.has(id)||!['waiting','unknown','changed'].includes(row.status))
      throw new AppError('这次操作正在提交或已结束，请先核对结果',409);
    if(row.operation==='create'){
      if(row.status!=='unknown')throw new AppError('新建操作仍在进行或已结束',409);
      // This only stops local recovery tracking. A possible native conversation
      // is preserved and may still appear in the normal catalog.
      this.update(id,'cancelled');
      return this.receipt(this.row(id));
    }
    // Cancel stops further waiting; it never pretends to undo an already applied archive.
    await this.work(id,async()=>{
      const state=await this.archive({operation:'inspect',threadId:row.thread_id,codexHome:this.codexHome,
        ...(row.operation==='restore'?{rootOnly:true}:{})});
      if(this.stopped)return;
      this.sync();
      const achieved=row.operation==='archive'?state.status==='archived'&&state.verified===true:state.rootArchived===false;
      this.update(id,achieved?'succeeded':'cancelled');
    });
    return this.receipt(this.row(id));
  }
  async tick() {
    if(this.stopped||this.ticking)return;
    this.ticking=true;
    try {
      const rows=this.store.db.prepare(`SELECT id,operation,plan FROM lifecycle_operations
        WHERE status='waiting' OR (operation='create' AND status='unknown' AND thread_id IS NOT NULL
          AND CASE WHEN json_valid(plan) THEN json_extract(plan,'$.creationStatus') END='created')
        ORDER BY CASE WHEN status='waiting' THEN 0 ELSE 1 END,created_at LIMIT 50`).all();
      for(const row of rows){
        if(this.stopped)break;
        if(row.operation==='create'){
          if(planOf(row).creationStatus==='created')await this.work(row.id,()=>this.finishCreate(row.id));
        }else await this.work(row.id,()=>this.archiveStep(row.id));
      }
    }finally{this.ticking=false;}
  }
  start(){this.timer=setInterval(()=>void this.tick(),this.tickMs);this.timer.unref();}
  stop(){this.stopped=true;clearInterval(this.timer);}
}
