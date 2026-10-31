// test/extension.test.ts
// Static extension validation: manifest shape, JavaScript syntax, and required fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "..", "extension");

test("manifest.json is valid MV3", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.equal(typeof m.name, "string");
  assert.match(m.version, /^\d+\.\d+\.\d+/);
  assert.ok(m.host_permissions?.some((h: string) => h.includes("chatgpt.com")));
  assert.ok(m.host_permissions?.some((h: string) => h.includes("8765")));
  assert.equal(m.background?.service_worker, "service-worker.js");
  assert.equal(m.background?.type, "module");
  assert.ok(m.content_scripts?.[0]?.js?.includes("content-script.js"));
  assert.equal(m.action?.default_popup, "popup.html");
});

test("all files referenced by manifest exist", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const files = [
    m.background.service_worker,
    ...m.content_scripts.flatMap((cs: { js: string[] }) => cs.js),
    m.action.default_popup,
    ...Object.values(m.action.default_icon ?? {}),
    ...Object.values(m.icons ?? {}),
  ] as string[];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(EXT, f)), `missing: ${f}`);
  }
});

test("content-script.js parses as script", () => {
  const src = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  new vm.Script(src, { filename: "content-script.js" });
});

test("status widget loads before the content script and parses as a script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("status-widget.js") >= 0);
  assert.ok(scripts.indexOf("status-widget.js") < scripts.indexOf("content-script.js"));
  new vm.Script(fs.readFileSync(path.join(EXT, "status-widget.js"), "utf8"));
});

test("service-worker.js parses when imports stripped", () => {
  const src = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  const stripped = src.replace(/^import[^;]+;$/gm, "// stripped import");
  new vm.Script(stripped, { filename: "service-worker.js" });
});

test("popup.js parses as script", () => {
  const src = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  new vm.Script(src, { filename: "popup.js" });
});

test("popup.html references popup.js and popup.css", () => {
  const html = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  assert.match(html, /popup\.js/);
  assert.match(html, /popup\.css/);
});

test("popup displays the server's active task status", () => {
  const src = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  assert.match(src, /activeTaskStatus/);
  assert.match(src, /active=/);
});

test("config.js exports required constants", () => {
  const src = fs.readFileSync(path.join(EXT, "lib", "config.js"), "utf8");
  for (const sym of [
    "DEFAULT_BASE",
    "POLL_ALARM_NAME",
    "HEARTBEAT_ALARM_NAME",
    "STORAGE_KEYS",
    "RUN_TASK_ACK_TIMEOUT_MS",
    "POLL_LATE_REPLY_GRACE_MS",
    "SUBMISSION_VERIFICATION_MS",
    "RECOVERY_OBSERVATION_INTERVAL_MS",
    "ATTACHMENT_BLOCK_CLEAN_STABLE_MS",
  ]) {
    assert.match(src, new RegExp(`export const ${sym}`), `missing export: ${sym}`);
  }
});

test("content-script contains required message handlers", () => {
  const src = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  for (const t of ["get-session-id", "get-inflight", "get-page-state", "check-safety", "update-banner", "run-task", "recover-inflight", "send-attempted", "offline", "online"]) {
    assert.match(src, new RegExp(`"${t}"`), `missing handler: ${t}`);
  }
  assert.doesNotMatch(
    src,
    /type:\s*"requeue-task"/,
    "refresh recovery must not make a task resendable",
  );
});

test("generation detection ignores hidden stop buttons", () => {
  const src = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  assert.match(
    src,
    /function isGenerating\(\)[\s\S]*querySelectorAll[\s\S]*isVisible/,
  );
});

test("content waits for hydrated stable page and verified submission", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  assert.match(content, /document\.readyState !== "complete"/);
  assert.match(content, /conversation-hydrating/);
  assert.match(content, /PAGE_READY_STABLE_MS/);
  assert.match(content, /waitForSubmissionAccepted/);
  // Worker readiness and the owned-new-page exception are exercised by the
  // behavioral dispatch tests in extension-session-creation.test.ts.
});

test("run-task acknowledgement and late reply capture are bounded", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  const config = fs.readFileSync(path.join(EXT, "lib", "config.js"), "utf8");
  assert.match(worker, /RUN_TASK_ACK_TIMEOUT_MS/);
  assert.match(config, /RUN_TASK_ACK_TIMEOUT_MS\s*=\s*240_000/);
  const duration = (source: string, name: string) => {
    const value = source.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`))?.[1];
    assert.ok(value, `missing ${name}`);
    return Number(value.replaceAll("_", ""));
  };
  const ackMs = duration(config, "RUN_TASK_ACK_TIMEOUT_MS");
  const pageReadyMs = duration(content, "PAGE_READY_TIMEOUT_MS");
  const uploadMs = duration(content, "ATTACHMENT_UPLOAD_TIMEOUT_MS");
  const acceptanceMs = duration(content, "SUBMISSION_ACCEPT_TIMEOUT_MS");
  assert.ok(ackMs > pageReadyMs + uploadMs + acceptanceMs + 55_000);
  assert.match(worker, /lateReplyDeadlineAt/);
  assert.match(worker, /\/capture/);
});

test("large-paste attachments receive a separate upload budget and safe failure path", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  assert.match(content, /TEXT_SEND_READY_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(content, /ATTACHMENT_UPLOAD_TIMEOUT_MS\s*=\s*90_000/);
  assert.match(content, /attachment_upload_timeout/);
  assert.match(content, /cleanupAfterAttachmentFailure/);
  assert.match(worker, /attachmentCleanupConfirmed/);
  assert.match(worker, /preserveQueued:\s*true/);
  assert.match(worker, /ATTACHMENT_BLOCKS/);
});

test("provisional task observations are rate-limited and omit partial reply text", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  const config = fs.readFileSync(path.join(EXT, "lib", "config.js"), "utf8");
  assert.match(content, /activity,/);
  assert.match(content, /outputChars,/);
  assert.match(worker, /\/internal\/tasks\/\$\{taskId\}\/observation/);
  assert.match(worker, /TASK_OBSERVATION_CHANGE_INTERVAL_MS/);
  assert.match(worker, /TASK_OBSERVATION_HEARTBEAT_INTERVAL_MS/);
  assert.match(config, /TASK_OBSERVATION_CHANGE_INTERVAL_MS\s*=\s*10_000/);
  assert.doesNotMatch(worker, /observation[^\n]*lastText/);
});

test("durable send fence precedes Send and post-attempt polling cannot requeue", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  const fence = content.indexOf('type: "send-attempted"');
  const click = content.indexOf("await clickSend(target)", fence);
  assert.ok(fence >= 0, "missing content-script send fence");
  assert.ok(click > fence, "Send must occur only after the durable fence");
  assert.match(worker, /snap\.status === "not-started"[\s\S]*hasSendFence\(rec\)/);
  assert.match(worker, /classifySubmissionVerification/);
  assert.match(worker, /submission_not_observed/);
  assert.doesNotMatch(worker, /status=queued&limit=500/);
  assert.match(worker, /reportTaskProgress\(taskId, "recovery_observed", rec.claimToken\)/);
  assert.match(worker, /t\?\.status === "in_progress" \|\| t\?\.status === "recovering"/);
  assert.doesNotMatch(worker, /requeuePending/);
});

test("scoped composer cleanup and prompt injection remain available", () => {
  const content = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  const worker = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  assert.match(content, /async function resetComposer/);
  assert.match(content, /range\.selectNodeContents\(inp\)/);
  assert.doesNotMatch(content, /range\.collapse\(false\)/);
  assert.match(content, /type === "reset-composer"/);
  assert.match(content, /type: "submission-failed-evidence"/);
  assert.match(worker, /composerPayloadObservedAfterFailure/);
});
