import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { SessionControls } from "../server/session-controls.js";

const id = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
function setup() {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db, loadConfig());
  store.touchSession(id);
  const diagnostics = new SessionDiagnostics(db, store);
  const controls = new SessionControls(db, store, diagnostics);
  let revision = 0;
  const inventory = (policy: string | null = "reclaimable") => diagnostics.instances.report({owner:"edge",generation:1,revision:++revision,
    controls:["close"],tabs:[{tabId:7,conversationId:id,lifecyclePolicy:policy}]});
  inventory();
  diagnostics.report({owner:"edge",generation:1,tabId:7,session:id,protocol:1,ready:true,composerClean:true,generating:false});
  const request = {operationId:"automatic-close-1",kind:"close",session:id,automatic:true};
  const claim = () => {
    controls.create(request);
    const command = controls.claim("edge")!;
    assert.equal(command.target.automatic,true);
    return {owner:"edge",token:command.token,generation:1,documentId:"doc"};
  };
  return {db,store,controls,inventory,request,claim};
}

test("automatic close requires reclaimable inventory and an empty session", () => {
  const f = setup();
  try {
    for (const policy of [null,"protected"]) {
      f.inventory(policy);
      assert.throws(() => f.controls.create(f.request),/page_protected/);
    }
    f.inventory();
    f.store.createTask({session:id,text:"queued"});
    assert.throws(() => f.controls.create(f.request),/session_busy/);
    assert.throws(() => f.controls.create({...f.request,kind:"refresh"}),/invalid_control/);
  } finally {f.db.close();}
});

test("a queue race blocks automatic close at the fence and releases its gate", () => {
  const f = setup();
  try {
    const evidence = f.claim();
    assert.throws(() => f.controls.create({...f.request,operationId:"other-close-id"}),/control_in_progress/);
    const task = f.store.createTask({session:id,text:"new work"});
    assert.equal(f.store.claimNextTask(id),null);
    const receipt = f.controls.fence(f.request.operationId,evidence);
    assert.equal(receipt.execute,false);
    assert.equal(receipt.state,"blocked");
    assert.equal(receipt.error,"session_busy");
    assert.equal(f.store.isSuspended(id),false);
    assert.equal(f.store.claimNextTask(id)!.id,task.id);
  } finally {f.db.close();}
});

test("automatic close reserves execution without permanent suspension", () => {
  const f = setup();
  try {
    const evidence = f.claim();
    assert.equal(f.controls.fence(f.request.operationId,evidence).execute,true);
    assert.equal(f.store.isSuspended(id),false);
    const task = f.store.createTask({session:id,text:"arrived after fence"});
    assert.equal(f.store.claimNextTask(id),null);
    const result = f.controls.finish(f.request.operationId,{...evidence,state:"succeeded",result:{action:"page_closed",suspended:true}});
    assert.equal(result.result.suspended,false);
    assert.equal(result.suspended,false);
    assert.equal(f.store.claimNextTask(id)!.id,task.id);
    assert.throws(() => f.controls.create({...f.request,automatic:false}),/operation_id_conflict/);
  } finally {f.db.close();}
});

test("automatic close rechecks protection and preserves user suspension", () => {
  const f = setup();
  try {
    const evidence = f.claim();
    f.inventory("protected");
    assert.equal(f.controls.fence(f.request.operationId,evidence).error,"page_protected");
    f.inventory();
    f.store.suspendDispatch(id,true);
    f.controls.create({...f.request,operationId:"automatic-close-2"});
    const command = f.controls.claim("edge")!;
    const second = {...evidence,token:command.token};
    assert.equal(f.controls.fence(command.operationId,second).execute,true);
    assert.equal(f.controls.finish(command.operationId,{...second,state:"succeeded"}).suspended,true);
    assert.equal(f.store.isSuspended(id),true);
  } finally {f.db.close();}
});

test("targeted close claim can run while an older open control is executing", () => {
  const f=setup();
  try {
    f.controls.create(f.request);
    // The open control is for another session whose capacity reclamation needs
    // this close; an unscoped claim must retain its existing oldest-first order.
    f.db.prepare(`INSERT INTO session_controls
      (id,session,owner,tab,kind,state,token,created_at,expires_at)
      VALUES ('executing-open-1','other-session','edge',-1,'open','executing','open-token',?,?)`)
      .run(Date.now()-1000,Date.now()+60_000);
    assert.equal(f.controls.claim("edge")!.operationId,"executing-open-1");
    const close=f.controls.claim("edge",f.request.operationId)!;
    assert.equal(close.operationId,f.request.operationId);
    assert.equal(close.state,"claimed");
    assert.equal(f.controls.claim("edge",f.request.operationId)!.token,close.token);
    assert.equal(f.controls.row("executing-open-1")!.state,"executing");
    assert.equal(f.controls.claim("another-owner",f.request.operationId),null);
    assert.equal(f.controls.claim("edge","missing-operation"),null);
    // Targeting does not bypass the automatic-close safety fence.
    f.inventory("protected");
    assert.equal(f.controls.fence(close.operationId,{owner:"edge",token:close.token,generation:1,documentId:"doc"}).execute,false);
    assert.equal(f.controls.claim("edge",f.request.operationId),null);
  } finally { f.db.close(); }
});

test("targeted claim excludes expired and terminal controls", () => {
  const f=setup();
  try {
    f.controls.create(f.request);
    f.db.prepare("UPDATE session_controls SET expires_at=? WHERE id=?").run(Date.now()-1,f.request.operationId);
    assert.equal(f.controls.claim("edge",f.request.operationId),null);
    assert.equal(f.controls.row(f.request.operationId)!.state,"unknown");
    assert.equal(f.controls.claim("edge",f.request.operationId),null);
    assert.throws(()=>f.controls.claim("edge","bad"),/invalid_control/);
  } finally { f.db.close(); }
});
