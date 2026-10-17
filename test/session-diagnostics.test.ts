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
    assert.equal(diagnostics.inspect("diag", Date.now() + SNAPSHOT_TTL_MS + 1)!.pageStatus, "unknown");
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
    assert.equal(diagnostics.inspect(ref)!.browser.status, 'script_unreachable');
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
