#!/usr/bin/env node
// bin/gpt-relay.ts
// gpt-relay CLI: start/health/tasks/show/cancel/sessions/resume/review。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

async function cmdSessions(args: string[] = []): Promise<number> {
  if (["inspect", "suspend", "continue", "refresh"].includes(args[0] ?? "")) {
    const flag = args.includes("--session-ref") ? "--session-ref" : "--session";
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1] || args.includes("--session-ref") && args.includes("--session"))
      throw new Error("usage: sessions inspect|suspend|continue|refresh --session-ref REF | --session ID");
    if (args[0] === "refresh") {
      const recovery = args.indexOf("--recover-task");
      if (recovery >= 0 && !args[recovery + 1]) throw new Error("missing recovery task ID");
      return submitControl({ kind: "refresh", session: args[i + 1], taskId: recovery < 0 ? null : args[recovery + 1] }, args);
    }
    const route = `/v1/sessions/${encodeURIComponent(args[i + 1]!)}/${args[0]}`;
    console.log(JSON.stringify(args[0] === "inspect" ? await http.get(route, { baseUrl: BASE }) :
      await http.post(route, {}, { baseUrl: BASE })));
    return 0;
  }
  const refIndex = args.indexOf("--session-ref");
  if (refIndex >= 0) {
    const ref = args[refIndex + 1];
    if (!ref) throw new Error("missing session ref");
    const row = await http.get(`/v1/sessions/${encodeURIComponent(ref)}`, { baseUrl: BASE });
    console.log(JSON.stringify(row));
    return 0;
  }
  const sessions = await listSessions(BASE);
  if (args.includes("--json")) { console.log(JSON.stringify({ sessions })); return 0; }
  if (sessions.length === 0) {
    console.log("(no active sessions)");
    return 0;
  }
  console.log(
    ["session", "pending", "active", "activeStatus", "paused", "reason", "lastSeen"].join("\t"),
  );
  for (const s of sessions) {
    console.log(
      [
        s.session.slice(0, 12) + "…",
        s.pendingTasks,
        (s.activeTaskId ?? s.inProgressTaskId) ? "yes" : "no",
        s.activeTaskStatus ?? (s.inProgressTaskId ? "in_progress" : ""),
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
  submissionState: string;
}

async function cmdTasks(args: string[]): Promise<number> {
  if (args[0] === "recover") {
    if (!args[1]) throw new Error("usage: tasks recover TASK_ID [--operation-id ID]");
    return submitControl({ kind: "recover", taskId: args[1] }, args);
  }
  if (args[0] === "trace") {
    if (!args[1]) throw new Error("usage: tasks trace TASK_ID");
    console.log(JSON.stringify(await http.get(`/v1/tasks/${encodeURIComponent(args[1])}/trace`, { baseUrl: BASE })));
    return 0;
  }
  const q = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--session") q.set("session", args[++i] ?? "");
    else if (a === "--session-ref") q.set("sessionRef", args[++i] ?? "");
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
  console.log(
    ["taskId", "session", "status", "submission", "submittedAt", "elapsedMs"].join("\t"),
  );
  for (const t of r.tasks) {
    const elapsed =
      t.completedAt != null ? t.completedAt - t.submittedAt : Date.now() - t.submittedAt;
    console.log(
      [
        t.taskId.slice(0, 8),
        t.session.slice(0, 10),
        t.status,
        t.submissionState,
        new Date(t.submittedAt).toISOString(),
        `${elapsed}ms`,
      ].join("\t"),
    );
  }
  return 0;
}

async function submitControl(body: Record<string, unknown>, args: string[]): Promise<number> {
  const index = args.indexOf("--operation-id");
  const operationId = index < 0 ? randomUUID() : args[index + 1];
  if (!operationId) throw new Error("missing operation ID");
  // Keep the identifier even when the HTTP response is lost: retry with the same ID.
  console.error(JSON.stringify({ operationId }));
  console.log(JSON.stringify(await http.post("/v1/session-controls", { ...body, operationId }, { baseUrl: BASE })));
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
  console.log(`  submission:  ${t.submissionState}`);
  if (t.submissionState === "verifying" && t.submissionVerificationDeadlineAt) {
    console.log(
      `  verify until: ${new Date(t.submissionVerificationDeadlineAt).toISOString()}`,
    );
  }
  if (t.status === "recovering") {
    console.log(`  recovery:    ${t.recoveryReason ?? "deadline exceeded"}`);
    console.log(
      `  lease until: ${t.recoveryLeaseDeadlineAt
        ? new Date(t.recoveryLeaseDeadlineAt).toISOString()
        : "(awaiting extension evidence)"}`,
    );
    console.log(`  hard limit:  ${new Date(t.recoveryDeadlineAt).toISOString()}`);
  }
  console.log(`  submitted:   ${new Date(t.submittedAt).toISOString()}`);
  console.log(
    `  dispatched:  ${t.dispatchedAt ? new Date(t.dispatchedAt).toISOString() : "(pending)"}`,
  );
  console.log(
    `  completed:   ${t.completedAt ? new Date(t.completedAt).toISOString() : "(pending)"}`,
  );
  console.log(`  requeues:    ${t.requeueCount}`);
  if (t.progress) {
    console.log("\n─── progress (provisional) ─────────────────────");
    console.log(`  phase:       ${t.progress.phase}`);
    if (t.progress.activity) console.log(`  activity:    ${t.progress.activity}`);
    console.log(`  outputChars: ${t.progress.outputChars}`);
    console.log(`  changed:     ${new Date(t.progress.changedAt).toISOString()}`);
    console.log(`  observed:    ${new Date(t.progress.observedAt).toISOString()}`);
    console.log("  note:        scheduling signal only; wait for a final reply");
  }
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
  if (t.status === "recovering") {
    console.log("\nNOTE: ChatGPT may still be producing this reply. Do not resubmit the prompt.");
    console.log("Use `gpt-relay show` or `gpt-relay resume`, or cancel explicitly.");
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
      if (record.requestOnly) {
        console.log(`${record.session}\tUNCONFIRMED\t"${preview}"; keep request ID ${record.clientRequestId}`);
        continue;
      }
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
    if (task.status === "recovering") {
      console.log("  note: still awaiting the original reply; do not resubmit");
    }
    if (task.submissionState === "verifying") {
      console.log("  note: verifying whether ChatGPT accepted the original submission");
    }
    if (task.progress) {
      const activity = task.progress.activity ? `, ${task.progress.activity}` : "";
      console.log(
        `  progress: ${task.progress.phase}, ${task.progress.outputChars} chars${activity} (provisional)`,
      );
    }
    if (task.error) console.log(`  error: ${task.error}`);
  }
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  let session = "";
  let sessionRef = "";
  let newSession = false;
  let projectId: string | null | undefined;
  let projectChoices = 0;
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
    else if (a === "--session-ref") sessionRef = args[++i] ?? "";
    else if (a === "--new-session") newSession = true;
    else if (a === "--project-id") { projectId = args[++i]; projectChoices++; }
    else if (a === "--no-project") { projectId = null; projectChoices++; }
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
  if (Boolean(session) === Boolean(sessionRef) ||
    (newSession && (!sessionRef || projectChoices !== 1 || projectId === "" || projectId === undefined)) ||
    (!newSession && projectChoices > 0)) {
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
    session: session || undefined,
    sessionRef: sessionRef || undefined,
    newSession,
    ...(newSession ? { projectId } : {}),
    baseUrl: BASE,
    wait,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    ...(cri !== undefined ? { clientRequestId: cri } : {}),
  });
  if ("reply" in r && r.reply !== undefined) {
    if (r.status === "done" || r.lateReply) {
      process.stdout.write(r.reply ?? r.lateReply ?? "");
      return 0;
    }
    console.error(`task ${r.taskId} ${r.status}: ${r.error ?? "(no error)"}`);
    return 2;
  }
  console.log(JSON.stringify(r));
  return 0;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdProjects(args: string[]): Promise<number> {
  const action = args[0];
  if (action === "discover") {
    if (args.slice(1).some(a => !["--save", "--no-wait", "--json"].includes(a))) throw new Error("invalid discovery option");
    let result = await http.post<{ discoveryId: string; status: string; error?: string }>(
      "/v1/projects/discover", { save: args.includes("--save") }, { baseUrl: BASE });
    if (!args.includes("--no-wait")) {
      const deadline = Date.now() + 125_000;
      while (["queued", "claimed"].includes(result.status)) {
        if (Date.now() >= deadline) throw new Error(`discovery wait expired; query /v1/projects/discover/${result.discoveryId}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = await http.get(`/v1/projects/discover/${result.discoveryId}`, { baseUrl: BASE });
      }
    }
    console.log(JSON.stringify(result));
    return result.status === "failed" ? 2 : 0;
  }
  if (!action || action === "--json") {
    const result = await http.get<{ projects: Array<{ projectId: string; name: string; description: string | null }> }>("/v1/projects", { baseUrl: BASE });
    if (action === "--json") console.log(JSON.stringify(result));
    else for (const p of result.projects) console.log(`${p.projectId}\t${p.name}\t${p.description ?? ""}`);
    return 0;
  }
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (!["--project-id", "--name", "--description"].includes(flag) || args[i + 1] === undefined || args[i + 1]!.startsWith("--")) {
      throw new Error("invalid projects option");
    }
    values[flag] = args[++i]!;
  }
  const id = values["--project-id"];
  if (!id) throw new Error("projects requires --project-id");
  const url = `/v1/projects/${encodeURIComponent(id)}`;
  if (action === "set") {
    if (!values["--name"]) throw new Error("projects set requires --name");
    await http.put(url, { name: values["--name"], ...(values["--description"] !== undefined
      ? { description: values["--description"] } : {}) }, { baseUrl: BASE });
  } else if (action === "remove") await http.del(url, { baseUrl: BASE });
  else throw new Error("unknown projects action");
  console.log(JSON.stringify({ status: "ok" }));
  return 0;
}

function usage(): void {
  console.log(`gpt-relay <command>

commands:
  projects [--json]        list local project metadata
  projects set --project-id ID --name NAME [--description TEXT]
  projects remove --project-id ID
  projects discover [--save] [--no-wait]
                           scan visible Project links in open ChatGPT tabs
  start                    start relay server (foreground)
  health                   check relay at ${BASE}
  sessions                 list active ChatGPT sessions
  tasks [--session ID] [--status S] [--last N]
                           list recent tasks
  show <taskId>            show full prompt + reply
  cancel <taskId>          cancel a task
  resume                   check pending tasks from previous run
  review --session ID (--text T | --stdin)
  review --session-ref REF (--text T | --stdin | --file F)
  review --new-session --session-ref REF (--project-id ID | --no-project)
         (--text T | --stdin | --file F) [--no-wait] [--cri KEY]
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
        return await cmdSessions(rest);
      case "projects":
        return await cmdProjects(rest);
      case "tasks":
        return await cmdTasks(rest);
      case "operations":
        if (!rest[0]) throw new Error("usage: operations OPERATION_ID");
        console.log(JSON.stringify(await http.get(`/v1/operations/${encodeURIComponent(rest[0])}`, { baseUrl: BASE })));
        return 0;
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
