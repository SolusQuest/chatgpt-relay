#!/usr/bin/env node
// Shim that lets the global npm wrapper start the TypeScript CLI correctly.
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
