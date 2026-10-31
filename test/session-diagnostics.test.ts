import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics, SNAPSHOT_TTL_MS } from "../server/session-diagnostics.js";

test("diagnostics distinguish missing, ambiguous and stale pages without leaking draft text", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    store.touchSession("diag");
    assert.equal(diagnostics.inspect("missing"), null);
    assert.equal(diagnostics.inspect("diag")!.pageStatus, "unknown");
    const report = { owner: "edge", tabId: 1, session: "diag", ready: true,
      generating: false, composerClean: false, protocol: 1, draft: "PRIVATE" };
    diagnostics.report(report);
    assert.equal(diagnostics.inspect("diag")!.page.composerClean, false);
    assert.ok(!JSON.stringify(diagnostics.inspect("diag")).includes("PRIVATE"));
    diagnostics.report({ ...report, tabId: 2 });
    assert.equal(diagnostics.inspect("diag")!.pageStatus, "ambiguous");
    assert.equal(diagnostics.inspect("diag")!.page, null);
    assert.equal(diagnostics.inspect("diag", Date.now() + SNAPSHOT_TTL_MS + 1)!.pageStatus, "page_snapshot_stale");
    store.touchSession("other");
    diagnostics.report({ ...report, tabId: 2, session: "other" });
    assert.equal(diagnostics.inspect("diag")!.pageStatus, "observed");
    assert.throws(() => diagnostics.report({ ...report, tabId: "1" }));
    assert.equal(diagnostics.doctor("diag").checks[0]!.code, "composer_unavailable");
    diagnostics.report({ ...report, capabilities: { composer: true }, protocol: null });
    assert.equal(diagnostics.doctor("diag").checks[0]!.code, "reload_extension_and_page");
    diagnostics.report({ ...report, capabilities: { composer: true } });
    assert.equal(diagnostics.doctor("diag").status, "ok");
    assert.equal(diagnostics.doctor("diag").checks[0]!.capabilities.assistantMessages, null);
  } finally { db.close(); }
});

test("conversation blocks remain visible to inspect and doctor without forwarding arbitrary page data", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    store.touchSession("blocked");
    const report = { owner: "edge", tabId: 1, session: "blocked", protocol: 1,
      capabilities: { composer: true }, ready: false, reason: "conversation_blocked",
      block: { code: "conversation_blocked", text: "会話の上限に達しました。", draft: "PRIVATE" } };
    diagnostics.report(report);
    assert.deepEqual(diagnostics.inspect("blocked")!.page.block,
      { code: "conversation_blocked", message: report.block.text });
    assert.ok(!JSON.stringify(diagnostics.inspect("blocked")).includes("PRIVATE"));
    assert.equal(diagnostics.doctor("blocked").status, "attention");
    assert.equal(diagnostics.doctor("blocked").checks[0]!.code, "conversation_blocked");
    assert.equal(diagnostics.doctor("blocked").checks[0]!.block.message, report.block.text);
    diagnostics.report({ ...report, block: { code: "arbitrary", text: "PRIVATE" } });
    assert.equal(diagnostics.inspect("blocked")!.page.block, null);
    diagnostics.report({ ...report, ready: true, reason: null, block: null });
    assert.equal(diagnostics.doctor("blocked").status, "ok");
    assert.equal(diagnostics.inspect("blocked", Date.now() + SNAPSHOT_TTL_MS + 1)!.page, null);
  } finally { db.close(); }
});

test('unbound creation diagnostics match only the owned tab, including before the first send', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new TaskStore(db, loadConfig());
    const ref = 'sr_pending';
    const registry = store.registry;
    registry.create(ref, null, 'fingerprint', () => store.createTask({session:ref,text:'prompt'}));
    const owned = registry.claim('browser')!;
    registry.opening(ref, 'browser', owned.token!);
    registry.attach(ref, 'browser', owned.token!, 7);
    const diagnostics = new SessionDiagnostics(db, store);
    const inventory = {owner:'browser',generation:1,revision:1,tabs:[
      {tabId:7,conversationId:null,loading:false}, {tabId:8,conversationId:null,loading:false},
    ]};
    diagnostics.instances.report(inventory);
    assert.equal(diagnostics.inspect(ref)!.browser.status, 'page_snapshot_unknown');
    diagnostics.report({owner:'browser',generation:1,tabId:7,session:ref,protocol:1,
      ready:false,composerClean:false,reason:'composer-not-clean'});
    diagnostics.report({owner:'browser',generation:1,tabId:8,session:ref,protocol:1});
    const result = diagnostics.inspect(ref)!;
    assert.equal(result.browser.status, 'observed');
    assert.deepEqual(result.browser.tabs.map(t => t.tabId), [7]);
    assert.equal(result.pageStatus, 'observed');
    assert.equal(result.page.tabId, 7);
    assert.equal(result.page.composerClean, false);
    diagnostics.instances.report({...inventory,revision:2,tabs:[inventory.tabs[1]!]});
    assert.equal(diagnostics.inspect(ref)!.browser.status, 'tab_missing');
    assert.equal(diagnostics.inspect(ref)!.pageStatus, 'unknown');
  } finally { db.close(); }
});

test("batch snapshots retain observation time, isolate invalid reports and order evidence", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    store.touchSession("batch");
    const diagnostics = new SessionDiagnostics(db, store);
    const now = Date.now();
    const report = { tabId: 1, session: "batch", revision: 2, observedAt: now - SNAPSHOT_TTL_MS - 1,
      documentId: "doc", probe: {ok: false, secret: "PRIVATE"}, draft: "PRIVATE" };
    const result = diagnostics.reportBatch({ owner: "browser", generation: 1, reports: [report, {tabId: "bad"}] });
    assert.equal(result[0]!.accepted, true);
    assert.equal(result[1]!.accepted, false);
    assert.equal(diagnostics.inspect("batch")!.pageStatus, "page_snapshot_stale");
    assert.equal(diagnostics.inspect("batch")!.pages[0]!.observedAt, report.observedAt);
    assert.ok(diagnostics.inspect("batch")!.pages[0]!.receivedAt >= now);
    assert.equal(diagnostics.report({...report, owner: "browser", generation: 1, revision: 1, observedAt: now}).accepted, false);
    assert.equal(diagnostics.report({...report, owner: "browser", generation: 1, revision: 3, observedAt: now}).accepted, true);
    assert.equal(diagnostics.inspect("batch")!.pageStatus, "page_probe_failed");
    assert.equal(diagnostics.doctor("batch").checks[0]!.code, "page_probe_failed");
    assert.ok(!JSON.stringify(diagnostics.inspect("batch")).includes("PRIVATE"));
    diagnostics.report({...report, owner: "browser", generation: 2, revision: 1, observedAt: now + 100000, probe: {ok:true}});
    assert.equal(diagnostics.inspect("batch")!.pageStatus, "observed");
    assert.ok(diagnostics.inspect("batch")!.page.observedAt <= Date.now());
    assert.equal(diagnostics.report({...report, owner: "browser", generation: 1, revision: 99, observedAt: now}).accepted, false);
  } finally { db.close(); }
});

test("inspection exposes live control and late capture reservations for safe capacity decisions", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const diagnostics = new SessionDiagnostics(db, store);
    store.touchSession("capacity");
    let inspected = diagnostics.inspect("capacity")!;
    assert.equal(inspected.controlsPending,false);
    assert.equal(inspected.latePending,false);
    assert.equal(inspected.activeTaskStatus,null);
    const task=store.createTask({session:"capacity",text:"prompt"});
    store.claimNextTask("capacity");
    assert.equal(diagnostics.inspect("capacity")!.activeTaskStatus,"in_progress");
    store.markTaskProgress(task.id,"send_attempted");
    db.prepare("UPDATE tasks SET status='failed', error='submission_outcome_unknown' WHERE id=?").run(task.id);
    assert.equal(diagnostics.inspect("capacity")!.latePending,true);
    const deadline=store.getLateReplyDeadlineAt(store.getTask(task.id)!);
    assert.equal(diagnostics.inspect("capacity",deadline+1)!.latePending,false);
    store.captureReply(task.id,"late response");
    assert.equal(diagnostics.inspect("capacity")!.latePending,false);
    db.prepare(`INSERT INTO session_controls (id,session,owner,tab,kind,state,token,created_at,expires_at)
      VALUES ('capacity-control','capacity','browser',7,'close','claimed','token',?,?)`).run(Date.now(),Date.now()+1000);
    assert.equal(diagnostics.inspect("capacity")!.controlsPending,true);
    assert.equal(diagnostics.inspect("capacity",Date.now()+2000)!.controlsPending,false);
  } finally { db.close(); }
});

test("capacity wait diagnostics match registered aliases, expire and exclude unrelated sessions", () => {
  const db=openDatabase(":memory:");
  try {
    const store=new TaskStore(db,loadConfig());
    store.touchSession("capacity"); store.touchSession("unrelated");
    const diagnostics=new SessionDiagnostics(db,store);
    const ref=store.registry.get("capacity")!.ref;
    diagnostics.instances.report({owner:"browser",generation:1,revision:1,tabs:[],
      dispatch:{state:"connected",waitingSessions:[ref,ref,"https://PRIVATE",42]}});
    assert.deepEqual(diagnostics.instances.list()[0]!.dispatch!.waitingSessions,[ref]);
    assert.equal(diagnostics.inspect("capacity")!.dispatch.waitingReason,"waiting_for_capacity");
    assert.equal(diagnostics.doctor("capacity").checks[0]!.code,"waiting_for_capacity");
    assert.equal(diagnostics.inspect("unrelated")!.dispatch.waitingReason,null);
    assert.equal(diagnostics.inspect("capacity",Date.now()+100000)!.dispatch.waitingReason,null);
  } finally {db.close();}
});

test("connected unified dispatch requires protocol 2 page evidence while legacy stays compatible",()=>{
  const db=openDatabase(":memory:");
  try {
    const store=new TaskStore(db,loadConfig());
    const id="6ac0da0c-f304-83e8-ac0f-25235ca1d760";
    store.touchSession(id);
    const diagnostics=new SessionDiagnostics(db,store);
    const inventory={owner:"browser",generation:1,revision:1,tabs:[{tabId:7,conversationId:id}]};
    const report={owner:"browser",generation:1,tabId:7,session:id,protocol:1,capabilities:{composer:true}};
    diagnostics.instances.report({...inventory,dispatch:{state:"legacy"}});
    diagnostics.report(report);
    assert.equal(diagnostics.doctor(id).checks[0]!.code,"ok");
    diagnostics.instances.report({...inventory,revision:2,dispatch:{state:"connected"}});
    assert.equal(diagnostics.doctor(id).checks[0]!.code,"reload_extension_and_page");
    assert.equal(diagnostics.inspect(id)!.page.dispatchProtocol,null);
    diagnostics.report({...report,dispatchProtocol:2});
    assert.equal(diagnostics.doctor(id).checks[0]!.code,"ok");
    assert.equal(diagnostics.inspect(id)!.page.dispatchProtocol,2);
    diagnostics.report({...report,dispatchProtocol:3});
    assert.equal(diagnostics.inspect(id)!.page.dispatchProtocol,null);
    assert.equal(diagnostics.doctor(id).checks[0]!.code,"reload_extension_and_page");
  } finally {db.close();}
});
