import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { TaskStore } from '../server/task-store.js';
import { Dispatch } from '../server/dispatch.js';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'relay-dispatch-'));
  const config={...loadConfig(),dbFile:join(dir,'test.db')};
  let db=openDatabase(config.dbFile), store=new TaskStore(db,config), dispatch=new Dispatch(db,store);
  db.exec("CREATE TABLE project_discoveries(id TEXT,state TEXT,owner TEXT,expires_at INTEGER)");
  return {get db(){return db},get store(){return store},get dispatch(){return dispatch},restart(){db.close();db=openDatabase(config.dbFile);store=new TaskStore(db,config);dispatch=new Dispatch(db,store)},close(){db.close();rmSync(dir,{recursive:true,force:true})}};
}
const page={session:'s1',tabId:1,documentId:'doc1'};
const id={owner:'browser',generation:'one'};
const request={...id,...page,requestId:'request1'};
const signal=()=>new AbortController().signal;
test('durable lost-response claim retries return same task and current terminal status',async()=>{
 const f=fixture();try {
  await f.dispatch.watch({...id,sessions:[page]},signal());
  const task=f.store.createTask({session:'s1',text:'hello'});
  const first=f.dispatch.claim(request).task!;
  assert.equal(first.taskId,task.id);assert.equal(f.dispatch.claim(request).task?.claimToken,first.claimToken);
  f.restart();assert.equal(f.dispatch.claim(request).task?.taskId,task.id);
  f.store.cancelTask(task.id);assert.equal(f.dispatch.claim(request).task?.status,'cancelled');
  assert.throws(()=>f.dispatch.validate(task.id,first.claimToken,true));
 }finally{f.close()}
});
test('empty claims persist and request payload conflicts reject',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  assert.equal(f.dispatch.claim(request).task,null);
  f.store.createTask({session:'s1',text:'later'});f.restart();
  assert.equal(f.dispatch.claim(request).task,null);
  assert.throws(()=>f.dispatch.claim({...request,documentId:'other'}));
  assert.ok(f.dispatch.claim({...request,requestId:'new'}).task);
 }finally{f.close()}
});
test('generation and page fences prevent obsolete sends and mixed legacy claims',async()=>{
 const f=fixture();try{
  const legacy=f.store.createTask({session:'s1',text:'legacy'});
  assert.equal(f.store.claimNextTask('s1')?.id,legacy.id);
  await f.dispatch.watch({...id,sessions:[page]},signal());
  f.dispatch.validate(legacy.id,undefined);f.store.completeTask(legacy.id,{text:'done'});
  f.store.createTask({session:'s1',text:'v2'});assert.equal(f.store.claimNextTask('s1'),null);
  const claimed=f.dispatch.claim(request).task!;
  assert.throws(()=>f.dispatch.validate(claimed.taskId,undefined));
  await f.dispatch.watch({...id,generation:'two',sessions:[page]},signal());
  assert.equal(f.dispatch.claim(request).task?.taskId,claimed.taskId);
  assert.throws(()=>f.dispatch.claim({...request,requestId:'obsolete-new'}));
  assert.throws(()=>f.dispatch.validate(claimed.taskId,claimed.claimToken,true));
  await assert.rejects(f.dispatch.watch({...id,sessions:[page]},signal()));
  assert.throws(()=>f.dispatch.register({...id,owner:'intruder'},[page]));
 }finally{f.close()}
});
test('watch waits with blocked queued work, wakes on changes, aborts without claiming',async()=>{
 const f=fixture();try{
  const initial=await f.dispatch.watch({...id,sessions:[page]},signal());
  f.store.createTask({session:'s1',text:'first'});f.dispatch.claim(request);
  f.store.createTask({session:'s1',text:'blocked'});
  const cursor=f.dispatch.cursor;
  let finished=false;
  const controller=new AbortController();
  const pending=f.dispatch.watch({...id,sessions:[page],cursor,waitMs:1000},controller.signal).then(v=>{finished=true;return v});
  await new Promise(r=>setTimeout(r,20));assert.equal(finished,false);
  controller.abort();const result=await pending;
  assert.equal(result.sessions.length,0);
  assert.equal(f.store.listTasks({session:'s1',status:'queued'}).length,1);
  assert.equal(f.store.listTasks({status:'in_progress'}).length,1);
  const wake=f.dispatch.watch({...id,sessions:[],cursor:f.dispatch.cursor,waitMs:1000},signal());
  f.dispatch.notify();assert.equal((await wake).sessions.length,0);
  assert.equal(initial.resyncRequired,true);
 }finally{f.close()}
});

test('resume rotates pre-send token once and never replays after Send',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  f.store.createTask({session:'s1',text:'resume'});
  const old=f.dispatch.claim(request).task!;
  await f.dispatch.watch({...id,generation:'two',sessions:[page]},signal());
  const resume={...request,generation:'two',originalGeneration:'one'};
  const next=f.dispatch.resume(resume).task!;
  assert.notEqual(next.claimToken,old.claimToken);
  assert.equal(f.dispatch.resume(resume).task?.claimToken,next.claimToken);
  assert.throws(()=>f.dispatch.validate(old.taskId,old.claimToken));
  f.dispatch.validate(next.taskId,next.claimToken,true);
  f.store.markTaskProgress(next.taskId,'send_attempted');
  await f.dispatch.watch({...id,generation:'three',sessions:[page]},signal());
  assert.ok(f.dispatch.resume({...resume,generation:'three',originalGeneration:'two'}).task?.sendAttemptedAt);
  assert.throws(()=>f.dispatch.validate(next.taskId,next.claimToken,true));
 }finally{f.close()}
});

test('parked subscriptions wake on work but cannot claim until attached',async()=>{
 const f=fixture();try{
  const parked={session:'s1',tabId:null,documentId:null};
  const initial=await f.dispatch.watch({...id,sessions:[parked]},signal());
  assert.throws(()=>f.dispatch.claim({...request,tabId:null,documentId:null}));
  assert.throws(()=>f.dispatch.claim(request));
  assert.equal(f.store.claimNextTask('s1'),null);
  const pending=f.dispatch.watch({...id,sessions:[parked],cursor:initial.cursor,waitMs:1000},signal());
  const task=f.store.createTask({session:'s1',text:'reopen'});
  const changed=await pending;
  assert.equal(changed.sessions[0]!.queuedTasks,1);
  assert.equal(f.store.getTask(task.id)?.status,'queued');
  await f.dispatch.watch({...id,sessions:[page]},signal());
  assert.equal(f.dispatch.claim(request).task?.taskId,task.id);
  // A stale parking update cannot remove an active page's claim authority.
  await f.dispatch.watch({...id,sessions:[parked]},signal());
  f.dispatch.validate(task.id,f.dispatch.claim(request).task!.claimToken,true);
 }finally{f.close()}
});

test('watch timeout returns snapshot after a missed external database update',async()=>{
 const f=fixture();try{
  const initial=await f.dispatch.watch({...id,sessions:[page]},signal());
  // Existing tasks blocked by active ownership do not cause immediate repeated
  // responses when the cursor is unchanged.
  f.store.createTask({session:'s1',text:'first'});f.dispatch.claim(request);
  f.store.createTask({session:'s1',text:'blocked'});
  const before=Date.now();
  const waiting=f.dispatch.watch({...id,sessions:[page],cursor:f.dispatch.cursor,waitMs:25},signal());
  f.db.prepare("UPDATE sessions SET paused=1 WHERE id=?").run('s1');
  const result=await waiting;
  assert.ok(Date.now()-before>=15);
  assert.equal(result.sessions[0]!.queuedTasks,1);
  assert.equal(result.sessions[0]!.paused,true);
  assert.notEqual(initial.cursor,result.cursor);
 }finally{f.close()}
});

test('parked subscription fences legacy successors even when legacy task remains active',async()=>{
 const f=fixture();try{
  const legacy=f.store.createTask({session:'s1',text:'legacy'});
  f.store.claimNextTask('s1');
  await f.dispatch.watch({...id,sessions:[{session:'s1',tabId:null,documentId:null}]},signal());
  f.store.completeTask(legacy.id,{text:'done'});
  f.store.createTask({session:'s1',text:'successor'});
  assert.equal(f.store.claimNextTask('s1'),null);
  assert.throws(()=>f.dispatch.claim(request));
 }finally{f.close()}
});
test('document replacement invalidates all pre-send old-page mutations until resume',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  f.store.createTask({session:'s1',text:'hello'});
  const original=f.dispatch.claim(request).task!;
  await f.dispatch.watch({...id,sessions:[{...page,documentId:'new-doc'}]},signal());
  assert.throws(()=>f.dispatch.validate(original.taskId,original.claimToken));
 }finally{f.close()}
});

test('refresh before Send relocates claim without overwriting original durable request',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  f.store.createTask({session:'s1',text:'refresh'});
  const source=f.dispatch.claim(request).task!;
  const updated={...page,documentId:'refreshed-doc'};
  await f.dispatch.watch({...id,sessions:[updated]},signal());
  const relocation={...request,...updated,originalGeneration:id.generation,resumeRequestId:'relocated-request'};
  const moved=f.dispatch.resume(relocation).task!;
  assert.equal(moved.taskId,source.taskId);assert.notEqual(moved.claimToken,source.claimToken);
  assert.equal(f.dispatch.resume(relocation).task?.claimToken,moved.claimToken);
  assert.equal(f.dispatch.claim(request).task?.claimToken,source.claimToken);
  assert.throws(()=>f.dispatch.validate(source.taskId,source.claimToken));
  f.dispatch.validate(moved.taskId,moved.claimToken,true);
  f.restart();
  const nextId={...id,generation:'next-worker'};
  await f.dispatch.watch({...nextId,sessions:[updated]},signal());
  const recovered=f.dispatch.resume({...relocation,...nextId,requestId:'relocated-request',originalGeneration:id.generation,resumeRequestId:'restart-request'}).task!;
  assert.equal(recovered.taskId,source.taskId);assert.notEqual(recovered.claimToken,moved.claimToken);
  f.dispatch.validate(recovered.taskId,recovered.claimToken,true);
 }finally{f.close()}
});

test('lost relocation response followed by worker restart can recover from original source',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  f.store.createTask({session:'s1',text:'lost refresh response'});
  const source=f.dispatch.claim(request).task!;
  const updated={...page,documentId:'new-doc'};
  await f.dispatch.watch({...id,sessions:[updated]},signal());
  const lost=f.dispatch.resume({...request,...updated,originalGeneration:id.generation,resumeRequestId:'lost-relocation'}).task!;
  f.restart();
  await f.dispatch.watch({...id,generation:'restart',sessions:[updated]},signal());
  const recovered=f.dispatch.resume({...request,...updated,generation:'restart',originalGeneration:id.generation,resumeRequestId:'new-relocation'}).task!;
  assert.equal(recovered.taskId,source.taskId);
  assert.throws(()=>f.dispatch.validate(source.taskId,lost.claimToken));
  f.dispatch.validate(recovered.taskId,recovered.claimToken,true);
 }finally{f.close()}
});

test('watch isolates a conflicting owner to its session while independent work proceeds',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  const occupied=f.store.createTask({session:'s1',text:'occupied'});
  f.dispatch.claim(request);
  const independent={session:'s2',tabId:2,documentId:'doc2'};
  const task=f.store.createTask({session:'s2',text:'independent'});
  const other={owner:'other-browser',generation:'one'};
  const snapshot=await f.dispatch.watch({...other,sessions:[page,independent]},signal());
  assert.deepEqual(snapshot.blockedSessions,[{session:'s1',reason:'dispatch_owner_conflict'}]);
  assert.deepEqual(snapshot.sessions.map(s=>s.session),['s2']);
  assert.throws(()=>f.dispatch.claim({...other,...page,requestId:'conflict'}));
  assert.equal(f.dispatch.claim({...other,...independent,requestId:'independent'}).task?.taskId,task.id);
  assert.equal(f.store.getTask(occupied.id)?.status,'in_progress');
  assert.throws(()=>f.dispatch.register(other,[page]));
 }finally{f.close()}
});

test('watch isolates a same-generation competing active tab without choosing it',async()=>{
 const f=fixture();try{
  await f.dispatch.watch({...id,sessions:[page]},signal());
  const task=f.store.createTask({session:'s1',text:'active'});
  const claimed=f.dispatch.claim(request).task!;
  const competing={...page,tabId:99,documentId:'otherdoc'};
  const snapshot=await f.dispatch.watch({...id,sessions:[competing]},signal());
  assert.deepEqual(snapshot.blockedSessions,[{session:'s1',reason:'dispatch_page_conflict'}]);
  assert.equal(snapshot.sessions.length,0);
  assert.throws(()=>f.dispatch.register(id,[competing]));
  assert.throws(()=>f.dispatch.claim({...request,...competing,requestId:'competing'}));
  f.dispatch.validate(task.id,claimed.claimToken,true);
 }finally{f.close()}
});
