import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";
import { SessionDiagnostics } from "../server/session-diagnostics.js";
import { INSTANCE_TTL_MS } from "../server/browser-instances.js";

const conversationId = "6ac0da0c-f304-83e8-ac0f-25235ca1d760";
test("complete inventories distinguish missing tabs, script loss, stale instances and reject delayed reports", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    store.touchSession(conversationId);
    const diagnostics = new SessionDiagnostics(db, store);
    const inventory = { owner: "browser", generation: 1, revision: 1, controls: ["open", "close"], tabs: [] as any[] };
    diagnostics.instances.report(inventory);
    assert.equal(diagnostics.instances.list()[0]!.stale, false);
    assert.equal(diagnostics.inspect(conversationId)!.browser.status, "tab_missing");
    diagnostics.instances.report({ ...inventory, revision: 2, tabs: [{ tabId: 7, conversationId, loading: false, url: "PRIVATE" }] });
    assert.equal(diagnostics.inspect(conversationId)!.browser.status, "page_snapshot_unknown");
    diagnostics.report({ owner: "browser", generation: 1, tabId: 7, session: conversationId, protocol: 1, capabilities: { composer: true } });
    assert.equal(diagnostics.inspect(conversationId)!.pageStatus, "observed");
    diagnostics.instances.report({ ...inventory, revision: 3 });
    assert.equal(diagnostics.inspect(conversationId)!.pageStatus, "unknown");
    assert.equal(diagnostics.inspect(conversationId)!.browser.status, "tab_missing");
    diagnostics.instances.report({ ...inventory, revision: 2, tabs: [{ tabId: 7, conversationId }] });
    assert.equal(diagnostics.instances.list()[0]!.tabs.length, 0);
    assert.equal(diagnostics.inspect(conversationId, Date.now() + INSTANCE_TTL_MS + 1)!.browser.status, "instance_stale");
    diagnostics.instances.report({ ...inventory, generation: 2, tabs: [{ tabId: 7, conversationId }] });
    assert.equal(diagnostics.inspect(conversationId)!.pageStatus, "unknown");
    diagnostics.instances.report({ ...inventory, revision: 100 });
    assert.equal(diagnostics.instances.list()[0]!.generation, 2);
    assert.ok(!JSON.stringify(diagnostics.instances.list()).includes("PRIVATE"));
    assert.throws(() => diagnostics.instances.report({ ...inventory, tabs: [{ tabId: 7, conversationId: "invalid" }] }));
  } finally { db.close(); }
});

test("legacy Project routes are retained only with responsive matching conversation evidence", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    store.touchSession(conversationId);
    const diagnostics = new SessionDiagnostics(db, store);
    const projectId = "g-p-" + "a".repeat(32);
    const report = { owner: "browser", tabId: 7, session: conversationId, conversationId, projectId };
    diagnostics.report(report);
    assert.equal(store.registry.get(conversationId)!.project, null);
    diagnostics.report({ ...report, protocol: 1, conversationId: "other" });
    assert.equal(store.registry.get(conversationId)!.project, null);
    diagnostics.report({ ...report, protocol: 1 });
    assert.equal(store.registry.get(conversationId)!.project, projectId);
    assert.equal(diagnostics.inspect(conversationId)!.projectId, projectId);
  } finally { db.close(); }
});

test("inventory observation freshness and dispatch health stay distinct and private", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    store.touchSession(conversationId);
    const diagnostics = new SessionDiagnostics(db, store);
    const now = Date.now();
    const inventory = {owner:"browser",generation:1,revision:1,observedAt:now,
      dispatch:{state:"disconnected",lastConnectedAt:now-1000,lastError:"PRIVATE URL"},
      tabs:[{tabId:7,conversationId,loading:false,lifecycle:"protected",waitingReason:"PRIVATE"}]};
    diagnostics.instances.report(inventory);
    const instance = diagnostics.instances.list()[0]!;
    assert.equal(instance.dispatch!.state,"disconnected");
    assert.equal(instance.dispatch!.lastError,null);
    assert.equal(instance.tabs[0]!.lifecycle,"protected");
    assert.equal(instance.tabs[0]!.waitingReason,null);
    assert.equal(diagnostics.doctor(conversationId).checks[0]!.code,"dispatch_disconnected");
    diagnostics.instances.report({...inventory,revision:2,observedAt:now-1000});
    assert.equal(diagnostics.instances.list()[0]!.revision,1);
    diagnostics.instances.report({...inventory,generation:2,observedAt:now-INSTANCE_TTL_MS-1000});
    assert.equal(diagnostics.instances.list()[0]!.stale,true);
    assert.ok(!JSON.stringify(diagnostics.instances.list()).includes("PRIVATE"));
  } finally { db.close(); }
});
