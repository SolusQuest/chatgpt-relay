#!/usr/bin/env node
// skills/gpt-relay-review/scripts/sessions.mjs
// 列出活跃 session，输出 JSON 数组，方便 agent 用 jq/JSON.parse 挑选。
import { httpJson } from "./lib.mjs";
const r = await httpJson("GET", "/v1/sessions");
process.stdout.write(JSON.stringify(r.sessions, null, 2));