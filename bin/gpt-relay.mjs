#!/usr/bin/env node
// Shim: 让 npm 全局安装后 wrapper 能正确启动 TypeScript CLI。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(__dirname, "gpt-relay.ts");
const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href;

const proc = spawn(
  process.execPath,
  ["--import", tsx, target, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

proc.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
