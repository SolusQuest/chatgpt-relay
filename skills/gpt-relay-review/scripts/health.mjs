#!/usr/bin/env node
// skills/gpt-relay-review/scripts/health.mjs
// 检查 relay 是否可达。exit 0=ok，1=不可达。
import { BASE, httpJson } from "./lib.mjs";
try {
  const r = await httpJson("GET", "/health");
  if (r?.status === "ok") { console.log(`ok (${BASE}, sessions=${r.sessions ?? 0})`); process.exit(0); }
  console.error(`unexpected: ${JSON.stringify(r)}`); process.exit(2);
} catch (e) {
  console.error(`relay not reachable at ${BASE}: ${e.message}`);
  console.error(`hint: start it with 'gpt-relay start' or 'node server/index.ts' in the gpt-relay repo`);
  process.exit(1);
}