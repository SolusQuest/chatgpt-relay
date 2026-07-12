#!/usr/bin/env node
// skills/gpt-relay-review/scripts/list.mjs
// 列出最近的 tasks（默认 20 条）。
import { httpJson } from "./lib.mjs";
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const limit = Number(argVal("--last")) || 20;
const session = argVal("--session");
const url = new URLSearchParams({ limit: String(limit) });
if (args.includes("--session") && session) url.set("session", session);
const r = await httpJson("GET", `/v1/tasks?${url}`);
console.log(["taskId","session","status","submittedAt","elapsedMs"].join("\t"));
for (const t of r.tasks) {
  const elapsed = t.completedAt ? t.completedAt - t.submittedAt : Date.now() - t.submittedAt;
  console.log([t.taskId.slice(0,8), t.session.slice(0,10), t.status,
    new Date(t.submittedAt).toISOString(), `${elapsed}ms`].join("\t"));
}