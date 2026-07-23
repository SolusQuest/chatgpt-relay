#!/usr/bin/env node
// skills/gpt-relay-review/scripts/resume.mjs
// 扫描 ~/.gpt-relay/pending 目录，对每个 taskId 查最新状态；terminal 项自动清理。
// 输出：一段人类可读表格 + 每条 done 的 reply（分隔线包围）。
import { httpJson, isTerminal, listPending, clearPending } from "./lib.mjs";
const items = listPending();
if (items.length === 0) { console.log("(no pending tasks)"); process.exit(0); }
for (const rec of items) {
  let t;
  try { t = await httpJson("GET", `/v1/tasks/${rec.taskId}`); }
  catch (e) {
    if (e.status === 404) {
      console.log(`${rec.taskId.slice(0,8)}\tGONE\t"${rec.textPreview.replace(/\s+/g," ")}"`);
      clearPending(rec.taskId);
      continue;
    }
    throw e;
  }
  console.log(`${t.taskId.slice(0,8)}\t${t.status}\t"${rec.textPreview.replace(/\s+/g," ")}"`);
  const keepForLate = t.status === "failed" && !t.lateReply &&
    t.lateReplyDeadlineAt > Date.now() &&
    ["任务处理超时", "pending reply hard timeout", "session 心跳丢失，任务被释放", "aborted"].includes(t.error);
  if (isTerminal(t.status) && !keepForLate) clearPending(t.taskId);
  if (t.status === "done" && t.reply) {
    console.log("─── reply ─────────────────────────────────");
    console.log(t.reply);
    console.log("───────────────────────────────────────────");
  }
  if (t.lateReply) {
    console.log("─── late reply ─────────────────────────────");
    console.log(t.lateReply);
    console.log("───────────────────────────────────────────");
  }
  if (t.error) console.log(`  error: ${t.error}`);
}
