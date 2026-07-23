#!/usr/bin/env node
// bin/gpt-relay.ts
// gpt-relay CLI: start/health/tasks/show/cancel/sessions/resume/review。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cancelTask,
  getTask,
  healthCheck,
  listSessions,
  resumePending,
  review,
} from "../client/agent-client.js";
import { http } from "../client/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;
const PORT = Number(process.env.GPT_RELAY_PORT ?? 8765);
const BASE = process.env.GPT_RELAY_URL ?? `http://127.0.0.1:${PORT}`;

async function cmdStart(args: string[]): Promise<number> {
  const entry = path.join(REPO_ROOT, "server", "index.ts");
  const proc = spawn(process.execPath, ["--import", TSX_LOADER, entry, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 0)));
}

async function cmdHealth(): Promise<number> {
  const ok = await healthCheck(BASE);
  if (ok) {
    console.log(`ok (${BASE})`);
    return 0;
  }
  console.error(`relay not reachable at ${BASE}`);
  return 1;
}

async function cmdSessions(): Promise<number> {
  const sessions = await listSessions(BASE);
  if (sessions.length === 0) {
    console.log("(no active sessions)");
    return 0;
  }
  console.log(
    ["session", "pending", "inFlight", "paused", "reason", "lastSeen"].join("\t"),
  );
  for (const s of sessions) {
    console.log(
      [
        s.session.slice(0, 12) + "…",
        s.pendingTasks,
        s.inProgressTaskId ? "yes" : "no",
        s.paused ? "yes" : "no",
        s.pauseReason ?? "",
        new Date(s.lastSeen).toISOString(),
      ].join("\t"),
    );
  }
  return 0;
}

interface CliTask {
  taskId: string;
  session: string;
  status: string;
  submittedAt: number;
  completedAt: number | null;
  error: string | null;
  reply: string | null;
  lateReply: string | null;
}

async function cmdTasks(args: string[]): Promise<number> {
  const q = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--session") q.set("session", args[++i] ?? "");
    else if (a === "--status") q.set("status", args[++i] ?? "");
    else if (a === "--last") q.set("limit", args[++i] ?? "20");
  }
  if (!q.has("limit")) q.set("limit", "20");
  const r = await http.get<{ tasks: CliTask[] }>(`/v1/tasks?${q}`, {
    baseUrl: BASE,
    timeoutMs: 5_000,
  });
  if (r.tasks.length === 0) {
    console.log("(no tasks)");
    return 0;
  }
  console.log(["taskId", "session", "status", "submittedAt", "elapsedMs"].join("\t"));
  for (const t of r.tasks) {
    const elapsed =
      t.completedAt != null ? t.completedAt - t.submittedAt : Date.now() - t.submittedAt;
    console.log(
      [
        t.taskId.slice(0, 8),
        t.session.slice(0, 10),
        t.status,
        new Date(t.submittedAt).toISOString(),
        `${elapsed}ms`,
      ].join("\t"),
    );
  }
  return 0;
}

async function cmdShow(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: gpt-relay show <taskId>");
    return 64;
  }
  const t = await getTask(id, BASE);
  if (!t) {
    console.error(`task not found: ${id}`);
    return 1;
  }
  console.log("─── task ───────────────────────────────────────");
  console.log(`  id:          ${t.taskId}`);
  console.log(`  session:     ${t.session}`);
  console.log(`  status:      ${t.status}`);
  console.log(`  submitted:   ${new Date(t.submittedAt).toISOString()}`);
  console.log(
    `  dispatched:  ${t.dispatchedAt ? new Date(t.dispatchedAt).toISOString() : "(pending)"}`,
  );
  console.log(
    `  completed:   ${t.completedAt ? new Date(t.completedAt).toISOString() : "(pending)"}`,
  );
  console.log(`  requeues:    ${t.requeueCount}`);
  if (t.text) {
    console.log("\n─── prompt ─────────────────────────────────────");
    console.log(t.text);
  }
  if (t.reply) {
    console.log("\n─── reply ──────────────────────────────────────");
    console.log(t.reply);
  }
  if (t.lateReply) {
    console.log("\n─── late reply ────────────────────────────────");
    console.log(t.lateReply);
  }
  if (t.error) {
    console.log("\n─── error ──────────────────────────────────────");
    console.log(t.error);
  }
  return 0;
}

async function cmdCancel(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: gpt-relay cancel <taskId>");
    return 64;
  }
  const t = await cancelTask(id, BASE);
  console.log(`${t.taskId}: ${t.status}`);
  return 0;
}

async function cmdResume(): Promise<number> {
  const rows = await resumePending(BASE);
  if (rows.length === 0) {
    console.log("(no pending tasks)");
    return 0;
  }
  for (const { record, task } of rows) {
    const preview = record.textPreview.replace(/\s+/g, " ");
    if (!task) {
      console.log(`${record.taskId.slice(0, 8)}\tGONE\t"${preview}"`);
      continue;
    }
    const line = [
      task.taskId.slice(0, 8),
      task.status,
      `"${preview}"`,
    ].join("\t");
    console.log(line);
    if (task.status === "done" && task.reply) {
      console.log("─── reply ────────────────");
      console.log(task.reply);
      console.log("──────────────────────────");
    }
    if (task.lateReply) {
      console.log("─── late reply ───────────");
      console.log(task.lateReply);
      console.log("──────────────────────────");
    }
    if (task.error) console.log(`  error: ${task.error}`);
  }
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  let session = "";
  let text = "";
  let readStdin = false;
  let file: string | null = null;
  let wait = true;
  let waitTimeoutMs: number | undefined;
  let taskTimeoutMs: number | undefined;
  let cri: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--session") session = args[++i] ?? "";
    else if (a === "--text") text = args[++i] ?? "";
    else if (a === "--stdin") readStdin = true;
    else if (a === "--file") file = args[++i] ?? null;
    else if (a === "--no-wait") wait = false;
    else if (a === "--timeout" || a === "--wait-timeout") {
      waitTimeoutMs = Number(args[++i]);
    }
    else if (a === "--task-timeout") taskTimeoutMs = Number(args[++i]);
    else if (a === "--cri") cri = args[++i];
  }
  if (!session) {
    console.error("usage: gpt-relay review --session <id> (--text T | --stdin | --file F) [--no-wait] [--wait-timeout ms] [--task-timeout ms] [--cri key]");
    return 64;
  }
  if (readStdin) {
    text = await readAllStdin();
  } else if (file) {
    const { readFileSync } = await import("node:fs");
    text = readFileSync(file, "utf8");
  }
  if (!text) {
    console.error("no text provided");
    return 64;
  }
  const r = await review(text, {
    session,
    baseUrl: BASE,
    wait,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    ...(cri !== undefined ? { clientRequestId: cri } : {}),
  });
  if ("reply" in r) {
    if (r.status === "done" || r.lateReply) {
      process.stdout.write(r.reply ?? r.lateReply ?? "");
      return 0;
    }
    console.error(`task ${r.taskId} ${r.status}: ${r.error ?? "(no error)"}`);
    return 2;
  }
  console.log(JSON.stringify({ taskId: r.taskId, status: r.status }));
  return 0;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function usage(): void {
  console.log(`gpt-relay <command>

commands:
  start                    start relay server (foreground)
  health                   check relay at ${BASE}
  sessions                 list active ChatGPT sessions
  tasks [--session ID] [--status S] [--last N]
                           list recent tasks
  show <taskId>            show full prompt + reply
  cancel <taskId>          cancel a task
  resume                   check pending tasks from previous run
  review --session ID (--text T | --stdin)
         [--wait-timeout ms] [--task-timeout ms]
                           submit a review and wait

env:
  GPT_RELAY_PORT (${PORT})     server port
  GPT_RELAY_URL                override base url
  GPT_RELAY_PENDING_DIR        agent pending records dir
`);
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "start":
        return await cmdStart(rest);
      case "health":
        return await cmdHealth();
      case "sessions":
        return await cmdSessions();
      case "tasks":
        return await cmdTasks(rest);
      case "show":
        return await cmdShow(rest);
      case "cancel":
        return await cmdCancel(rest);
      case "resume":
        return await cmdResume();
      case "review":
        return await cmdReview(rest);
      case undefined:
      case "-h":
      case "--help":
      case "help":
        usage();
        return 0;
      default:
        console.error(`unknown command: ${cmd}`);
        usage();
        return 64;
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
