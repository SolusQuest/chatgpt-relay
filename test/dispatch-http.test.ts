import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'relay-dispatch-http-'));
 const handle=createApp({...loadConfig(),dbFile:join(dir,'test.db'),maintenanceIntervalMs:60000});
 handle.stopMaintenance();
 const server=handle.app.listen(0,'127.0.0.1');
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=async(path:string,body:unknown,signal?:AbortSignal)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 return {...handle,base,post,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));handle.closeDatabase();rmSync(dir,{recursive:true,force:true})}};
}
const page={session:'s1',tabId:1,documentId:'doc'};
const id={owner:'browser',generation:'one'};
const request={...id,...page,requestId:'req'};
test('HTTP send fence rejects duplicates; token mutations and capture are idempotent',async()=>{
 const f=await fixture();try{
  await f.post('/internal/dispatch/watch',{...id,sessions:[page]});
  const task=f.store.createTask({session:'s1',text:'hello'});
  const claim=await (await f.post('/internal/dispatch/claim',request)).json() as any;
  const token={claimToken:claim.task.claimToken};
  assert.equal((await f.post(`/internal/tasks/${task.id}/progress`,{...token,phase:'send_attempted'})).status,200);
  const repeated=await f.post(`/internal/tasks/${task.id}/progress`,{...token,phase:'send_attempted'});
  assert.equal(repeated.status,409);assert.equal((await repeated.json() as any).error,'dispatch_send_already_fenced');
  assert.equal((await f.post(`/internal/tasks/${task.id}/capture`,{text:'reply'})).status,409);
  const captured=await (await f.post(`/internal/tasks/${task.id}/capture`,{...token,text:'reply'})).json() as any;
  assert.equal(captured.captured,true);
  const duplicate=await f.post(`/internal/tasks/${task.id}/capture`,{...token,text:'reply'});
  assert.equal(duplicate.status,200);assert.equal(f.store.getTask(task.id)?.reply,'reply');
 }finally{await f.close()}
});
test('HTTP watch registration does not wake itself; disconnect removes listener without claiming',async()=>{
 const f=await fixture();try{
  const initial=await (await f.post('/internal/dispatch/watch',{...id,sessions:[page]})).json() as any;
  let settled=false;
  const controller=new AbortController();
  const pending=f.post('/internal/dispatch/watch',{...id,sessions:[page],cursor:initial.cursor,waitMs:1000},controller.signal).then(r=>{settled=true;return r});
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);
  controller.abort();await assert.rejects(pending);
  await new Promise(r=>setTimeout(r,20));
  const task=f.store.createTask({session:'s1',text:'after disconnect'});
  await new Promise(r=>setTimeout(r,20));assert.equal(f.store.getTask(task.id)?.status,'queued');
  const snapshot=await (await f.post('/internal/dispatch/watch',{...id,sessions:[page],cursor:initial.cursor,waitMs:1000})).json() as any;
  assert.equal(snapshot.sessions[0].queuedTasks,1);
 }finally{await f.close()}
});
test('HTTP zero-session watch wakes for creation, discovery and control commands',async()=>{
 const f=await fixture();try{
  const waitFor=async(action:()=>Promise<unknown>,field:string)=>{
   const initial=await (await f.post('/internal/dispatch/watch',{...id,sessions:[]})).json() as any;
   const waiting=f.post('/internal/dispatch/watch',{...id,sessions:[],cursor:initial.cursor,waitMs:1000});
   await new Promise(r=>setTimeout(r,10));await action();
   const result=await (await waiting).json() as any;assert.equal(result.pendingCommands[field],true);
  };
  await waitFor(()=>f.post('/v1/sessions',{sessionRef:'sr_new',projectId:null,text:'new'}),'sessionCreation');
  await waitFor(()=>f.post('/v1/projects/discover',{save:false}),'projectDiscovery');
  // Controls use the current page diagnostic identity independently of dispatch
  // subscriptions, so a command must also wake a browser watching zero sessions.
  const task=f.store.createTask({session:'control',text:'hello'});
  f.store.claimNextTask('control');f.store.markTaskProgress(task.id,'send_attempted');
  assert.equal((await f.post('/internal/session-snapshots',{session:'control',owner:'browser',tabId:7,protocol:1})).status,200);
  await waitFor(()=>f.post('/v1/session-controls',{operationId:'control-watch-test',kind:'stop',taskId:task.id}),'sessionControl');
 }finally{await f.close()}
});
test('HTTP legacy active completion remains accepted and stale token cannot write after requeue',async()=>{
 const f=await fixture();try{
  const task=f.store.createTask({session:'s1',text:'legacy'});f.store.claimNextTask('s1');
  await f.post('/internal/dispatch/watch',{...id,sessions:[page]});
  assert.equal((await f.post(`/internal/tasks/${task.id}/complete`,{text:'legacy reply'})).status,200);
  const queued=f.store.createTask({session:'s1',text:'v2'});
  const first=(await (await f.post('/internal/dispatch/claim',request)).json() as any).task;
  assert.equal((await f.post(`/internal/tasks/${queued.id}/requeue`,{claimToken:first.claimToken})).status,200);
  const second=(await (await f.post('/internal/dispatch/claim',{...request,requestId:'next'})).json() as any).task;
  assert.notEqual(second.claimToken,first.claimToken);
  assert.equal((await f.post(`/internal/tasks/${queued.id}/progress`,{claimToken:first.claimToken,phase:'send_attempted'})).status,409);
  assert.equal(f.store.getTask(queued.id)?.sendAttemptedAt,null);
 }finally{await f.close()}
});

test('HTTP empty command claims, heartbeat and snapshots do not spin watch',async()=>{
 const f=await fixture();try{
  await f.post('/internal/heartbeat',{session:'s1'});
  await f.post('/internal/session-snapshots',{session:'s1',owner:'browser',tabId:1,protocol:1});
  const initial=await (await f.post('/internal/dispatch/watch',{...id,sessions:[page]})).json() as any;
  let settled=false;
  const controller=new AbortController();
  const pending=f.post('/internal/dispatch/watch',{...id,sessions:[page],cursor:initial.cursor,waitMs:1000},controller.signal).then(r=>{settled=true;return r});
  await f.post('/internal/heartbeat',{session:'s1'});
  await f.post('/internal/session-snapshots',{session:'s1',owner:'browser',tabId:1,protocol:1});
  await f.post('/internal/session-creations/claim',{owner:'browser'});
  await f.post('/internal/project-discoveries/claim',{owner:'browser'});
  await f.post('/internal/session-controls/claim',{owner:'browser'});
  await f.post('/internal/dispatch/claim',request);
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);
  controller.abort();await assert.rejects(pending);
 }finally{await f.close()}
});

test('HTTP resumable creation claim and inspect leave watch cursor stable',async()=>{
 const f=await fixture();try{
  await f.post('/v1/sessions',{sessionRef:'sr_capacity',projectId:null,text:'wait for capacity'});
  const command=(await (await f.post('/internal/session-creations/claim',{owner:'browser'})).json() as any).command;
  assert.ok(command);
  const initial=await (await f.post('/internal/dispatch/watch',{...id,sessions:[]})).json() as any;
  assert.equal(initial.pendingCommands.sessionCreation,true);
  let settled=false;
  const controller=new AbortController();
  const pending=f.post('/internal/dispatch/watch',{...id,sessions:[],cursor:initial.cursor,waitMs:1000},controller.signal).then(r=>{settled=true;return r});
  for(let n=0;n<3;n++) {
   await f.post('/internal/session-creations/claim',{owner:'browser'});
   await f.post(`/internal/session-creations/${command.sessionRef}/inspect`,{owner:'browser',token:command.token});
  }
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);
  controller.abort();await assert.rejects(pending);
 }finally{await f.close()}
});
