#!/usr/bin/env node
// skills/gpt-relay-review/scripts/review.mjs
// 提交一段文本给指定 session 的 ChatGPT，等待回复。
// 用法：
//   node review.mjs --session <id> --stdin
//   node review.mjs --session <id> --text "..."
//   node review.mjs --session <id> --file path/to/prompt.md
//   node review.mjs --session <id> --stdin --no-wait   # fire-and-forget
// 输出：成功时 stdout 是回复文本；失败非零退出，stderr 打印错误。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { httpJson, isTerminal, writePending, clearPending } from "./lib.mjs";

function parseArgs(argv) {
  const o = { wait: true, waitTimeoutMs: 10 * 60_000, taskTimeoutMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") o.session = argv[++i];
    else if (a === "--text") o.text = argv[++i];
    else if (a === "--stdin") o.stdin = true;
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--no-wait") o.wait = false;
    else if (a === "--timeout" || a === "--wait-timeout") o.waitTimeoutMs = Number(argv[++i]);
    else if (a === "--task-timeout") o.taskTimeoutMs = Number(argv[++i]);
    else if (a === "--cri") o.clientRequestId = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.session) {
  console.error("usage: review.mjs --session <id> (--text T | --stdin | --file F) [--no-wait] [--wait-timeout ms] [--task-timeout ms] [--cri key]");
  process.exit(64);
}

let text = args.text;
if (args.stdin) text = await readStdin();
if (args.file) text = fs.readFileSync(args.file, "utf8");
if (!text) { console.error("no text provided"); process.exit(64); }

const started = Date.now();
const cri = args.clientRequestId ?? randomUUID();
const taskBody = { session: args.session, text, clientRequestId: cri };
if (args.taskTimeoutMs != null) taskBody.timeout = args.taskTimeoutMs;
const created = await httpJson("POST", "/v1/tasks", taskBody);
const taskId = created.taskId;
if (created.encodingWarning) {
  process.stderr.write(`[gpt-relay] WARNING: server flagged suspicious encoding: ${created.encodingWarning}\n`);
  process.stderr.write(`[gpt-relay]   hint (PowerShell): $OutputEncoding = [System.Text.UTF8Encoding]::new()\n`);
}
if (created.encodingFixed) {
  process.stderr.write(`[gpt-relay] note: server auto-fixed encoding (${created.encodingFixed})\n`);
}
writePending({
  taskId, session: args.session, submittedAt: started,
  textPreview: text.slice(0, 80), clientRequestId: cri,
});
if (!args.wait) {
  process.stdout.write(JSON.stringify({ taskId, status: "queued" }));
  process.exit(0);
}

const deadline = started + args.waitTimeoutMs;
while (Date.now() < deadline) {
  const remaining = deadline - Date.now();
  const wait = Math.min(remaining, 30_000);
  const t = await httpJson("GET", `/v1/tasks/${taskId}?wait=${wait}`);
  if (isTerminal(t.status)) {
    const keepForLate = t.status === "failed" && !t.lateReply &&
      t.lateReplyDeadlineAt > Date.now() &&
      ["任务处理超时", "pending reply hard timeout", "session 心跳丢失，任务被释放", "aborted"].includes(t.error);
    if (!keepForLate) clearPending(taskId);
    if (t.status === "done") { process.stdout.write(t.reply ?? ""); process.exit(0); }
    if (t.lateReply) {
      process.stdout.write(t.lateReply);
      process.exit(0);
    }
    console.error(`task ${taskId} ${t.status}: ${t.error ?? "(no error)"}${keepForLate ? " (late reply still being tracked; try 'resume')" : ""}`);
    process.exit(2);
  }
}
console.error(`timeout after ${args.waitTimeoutMs}ms (taskId=${taskId} still pending; try 'resume')`);
process.exit(3);
