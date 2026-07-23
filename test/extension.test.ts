// test/extension.test.ts
// 扩展静态验证：manifest.json 合法、关键 JS 文件语法无错、必需字段存在。
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

test("config.js exports required constants", () => {
  const src = fs.readFileSync(path.join(EXT, "lib", "config.js"), "utf8");
  for (const sym of [
    "DEFAULT_BASE",
    "POLL_ALARM_NAME",
    "HEARTBEAT_ALARM_NAME",
    "STORAGE_KEYS",
    "RUN_TASK_ACK_TIMEOUT_MS",
    "POLL_LATE_REPLY_GRACE_MS",
  ]) {
    assert.match(src, new RegExp(`export const ${sym}`), `missing export: ${sym}`);
  }
});

test("content-script contains required message handlers", () => {
  const src = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  for (const t of ["get-session-id", "get-inflight", "get-page-state", "check-safety", "update-banner", "run-task", "recover-task", "requeue-task", "offline", "online"]) {
    assert.match(src, new RegExp(`"${t}"`), `missing handler: ${t}`);
  }
});

test("generation detection ignores hidden stop buttons", () => {
  const src = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");
  assert.match(
    src,
    /function isGenerating\(\)[\s\S]*querySelectorAll[\s\S]*isVisible/,
  );
});

test("run-task acknowledgement and late reply capture are bounded", () => {
  const src = fs.readFileSync(path.join(EXT, "service-worker.js"), "utf8");
  assert.match(src, /RUN_TASK_ACK_TIMEOUT_MS/);
  assert.match(src, /lateReplyDeadlineAt/);
  assert.match(src, /\/capture/);
});
