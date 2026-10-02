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
