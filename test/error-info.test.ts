import { test } from "node:test";
import assert from "node:assert/strict";
import { errorInfo } from "../server/error-info.js";
import { openDatabase } from "../server/db.js";
import { TaskStore } from "../server/task-store.js";
import { loadConfig } from "../server/config.js";

test("structured failures never confuse missing delivery evidence with safe replay", () => {
  assert.equal(errorInfo("Composer text changed during preparation").code, "composer_changed");
  assert.equal(errorInfo("HTTP failure").safeToResubmit, null);
  const db = openDatabase(":memory:");
  try {
    const store = new TaskStore(db, loadConfig());
    const task = store.createTask({ session: "errors", text: "test" });
    store.claimNextTask("errors");
    store.markTaskProgress(task.id, "send_attempted");
    const info = errorInfo("submission_outcome_unknown", store.getTask(task.id)!);
    assert.equal(info.deliveryState, "uncertain");
    assert.equal(info.safeToResubmit, false);
    assert.equal(info.nextAction, "inspect_trace_and_recover_original_task");
  } finally { db.close(); }
});

test("conversation errors retain a language-independent code through session pauses", () => {
  for (const message of ["conversation_blocked", "session paused: conversation_blocked", "session paused: conversation_blocked: 会話の上限", "safety: conversation_blocked"]) {
    const info = errorInfo(message);
    assert.equal(info.code, "conversation_blocked");
    assert.equal(info.nextAction, "inspect_conversation_error_and_start_new_session_if_required");
    assert.equal(info.safeToResubmit, null);
  }
});
