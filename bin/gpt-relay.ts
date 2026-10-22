#!/usr/bin/env node
import { parseEffortPolicy, type Effort, type EffortPolicy } from "../shared/effort.js";
// bin/gpt-relay.ts
// gpt-relay server launcher and backend-aware client commands.
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
  type TaskView,
} from "../client/agent-client.js";
import { effortDetails, effortSummary, reviewExitCode } from "../client/task-output.js";
import { http, HttpError } from "../client/http.js";
import { BackendError, probeBackend, type Backend } from "../client/backend.js";
import { readBinding, saveBinding, clearBinding } from "../client/backend-config.js";
import { resolveBackend, type BackendOptions } from "../client/backend-resolver.js";
import { discoverBackends, uniqueBackend } from "../client/discovery.js";
import { parseGlobalOptions, validateBusinessArgs } from "../client/cli-options.js";
import { CliOutput, OutputWriteError } from "../client/cli-output.js";
import { createInterface } from "node:readline/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;
const PORT = Number(process.env.GPT_RELAY_PORT ?? 8765);
let BASE = process.env.GPT_RELAY_URL ?? `http://127.0.0.1:${PORT}`;
let SERVER_ID: string | undefined;
const output = new CliOutput();

async function cmdBind(args: string[], options: BackendOptions): Promise<number> {
  if (new Set(args).size !== args.length) throw new BackendError("invalid_arguments", "duplicate bind option");
  if (options.server || args.some(a => a.startsWith("--") && !["--clear", "--json"].includes(a))) throw new BackendError("invalid_arguments", "usage: bind [address | --local | --clear] [--json]");
  const addresses = args.filter(a => !a.startsWith("--"));
  if (addresses.length > 1 || Number(addresses.length > 0) + Number(!!options.local) + Number(args.includes("--clear")) > 1) throw new BackendError("invalid_arguments", "choose exactly one bind target or --clear");
  if (args.includes("--clear")) { await clearBinding(); output.log(JSON.stringify({ cleared: true })); return 0; }
  if (!options.local && !addresses.length) {
    output.log(JSON.stringify({ binding: readBinding(), source: process.env.GPT_RELAY_URL ? "environment" : readBinding() ? "binding" : "discovery", environmentUrl: process.env.GPT_RELAY_URL ?? null }));
    return 0;
  }
  const backend = options.local ? uniqueBackend(await discoverBackends(true)) : await probeBackend(addresses[0]!);
  output.log(JSON.stringify({ binding: await saveBinding(backend) }));
  return 0;
}

async function cmdDetect(args: string[], options: BackendOptions): Promise<number> {
  if (new Set(args).size !== args.length) throw new BackendError("invalid_arguments", "duplicate detect option");
  if (options.server || args.some(a => !["--list", "--json"].includes(a))) throw new BackendError("invalid_arguments", "usage: detect [--local] [--list] [--json]");
  const candidates = await discoverBackends(!!options.local);
  if (args.includes("--list")) { output.log(JSON.stringify({ candidates })); return 0; }
  let selected: Backend;
  if (candidates.length > 1 && process.stdin.isTTY && process.stdout.isTTY && !args.includes("--json")) {
    candidates.forEach((backend, index) => console.error(`${index + 1}. ${backend.name}\t${backend.baseUrl}\t${backend.serverId}`));
    const input = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await input.question("Select a Relay server number: ");
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || !candidates[index]) throw new BackendError("invalid_arguments", "invalid server selection; binding unchanged");
      selected = candidates[index]!;
    } finally { input.close(); }
  } else selected = uniqueBackend(candidates);
  selected = await probeBackend(selected.baseUrl, { expectedId: selected.serverId });
  output.log(JSON.stringify({ binding: await saveBinding(selected) }));
  return 0;
}

function validateControlOptions(args: string[], flags: string[]) {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || flag !== "--json" && !flags.includes(flag)) throw new Error(`invalid or duplicate option: ${flag}`);
    seen.add(flag);
    if (flag !== "--json" && (!args[++i] || args[i]!.startsWith("--"))) throw new Error(`missing value: ${flag}`);
  }
  if (seen.has("--session") && seen.has("--session-ref")) throw new Error("provide exactly one session identity");
}

async function cmdStart(args: string[]): Promise<number> {
  const entry = path.join(REPO_ROOT, "server", "index.ts");
  const proc = spawn(process.execPath, ["--import", TSX_LOADER, entry, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 0)));
}

async function cmdHealth(): Promise<number> {
  const ok = await healthCheck(BASE, SERVER_ID);
  if (ok) {
    output.log(`ok (${BASE})`);
    return 0;
  }
  console.error(`relay not reachable at ${BASE}`);
  return 1;
}

async function cmdSessions(args: string[] = []): Promise<number> {
  if (["inspect", "suspend", "continue", "refresh", "open", "close", "effort"].includes(args[0] ?? "")) {
    validateControlOptions(args.slice(1), ["--session", "--session-ref",
      ...(["refresh", "open", "close", "effort"].includes(args[0]!) ? ["--operation-id"] : []),
      ...(args[0] === "effort" ? ["--effort", "--effort-fallback"] : []), ...(args[0] === "refresh" ? ["--recover-task"] : []), ...(args[0] === "open" ? ["--instance"] : [])]);
    const flag = args.includes("--session-ref") ? "--session-ref" : "--session";
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1] || args.includes("--session-ref") && args.includes("--session"))
      throw new Error("usage: sessions inspect|suspend|continue|refresh|open|close|effort --session-ref REF | --session ID");
    if (args[0] === "effort") {
      const effort = args[args.indexOf("--effort") + 1];
      const fallbackIndex = args.indexOf("--effort-fallback");
      const policy = parseEffortPolicy({ effort, effortFallback: fallbackIndex >= 0 ? args[fallbackIndex + 1] : undefined });
      return submitControl({ kind: "set-effort", session: args[i + 1], ...policy }, args);
    }
    if (args[0] === "open" || args[0] === "close") {
      const instance = args.indexOf("--instance");
      return submitControl({ kind: args[0], session: args[i + 1],
        ...(instance >= 0 ? { instanceId: args[instance + 1] } : {}) }, args);
    }
    if (args[0] === "refresh") {
      const recovery = args.indexOf("--recover-task");
      if (recovery >= 0 && !args[recovery + 1]) throw new Error("missing recovery task ID");
      return submitControl({ kind: "refresh", session: args[i + 1], taskId: recovery < 0 ? null : args[recovery + 1] }, args);
    }
    const route = `/v1/sessions/${encodeURIComponent(args[i + 1]!)}/${args[0]}`;
    output.log(JSON.stringify(args[0] === "inspect" ? await http.get(route, { baseUrl: BASE, serverId: SERVER_ID }) :
      await http.post(route, {}, { baseUrl: BASE, serverId: SERVER_ID })));
    return 0;
  }
  const refIndex = args.indexOf("--session-ref");
  if (refIndex >= 0) {
    const ref = args[refIndex + 1];
    if (!ref) throw new Error("missing session ref");
    const row = await http.get(`/v1/sessions/${encodeURIComponent(ref)}`, { baseUrl: BASE, serverId: SERVER_ID });
    output.log(JSON.stringify(row));
    return 0;
  }
  const sessions = await listSessions(BASE, SERVER_ID);
  if (args.includes("--json")) { output.log(JSON.stringify({ sessions })); return 0; }
  if (sessions.length === 0) {
    output.log("(no active sessions)");
    return 0;
  }
  output.log(
    ["session", "pending", "active", "activeStatus", "paused", "reason", "lastSeen", "effort", "fallback"].join("\t"),
  );
  for (const s of sessions) {
    output.log(
      [
        s.session.slice(0, 12) + "…",
        s.pendingTasks,
        (s.activeTaskId ?? s.inProgressTaskId) ? "yes" : "no",
        s.activeTaskStatus ?? (s.inProgressTaskId ? "in_progress" : ""),
        s.paused ? "yes" : "no",
        s.pauseReason ?? "",
        new Date(s.lastSeen).toISOString(),
        s.effortPolicy?.effort ?? "disabled",
        s.effortPolicy?.effortFallback ?? "-",
      ].join("\t"),
    );
  }
  return 0;
}

async function cmdTasks(args: string[]): Promise<number> {
  if (["recover", "stop", "reverify-effort"].includes(args[0] ?? "")) {
    if (!args[1]) throw new Error("usage: tasks recover|stop|reverify-effort TASK_ID [--operation-id ID]");
    validateControlOptions(args.slice(2), ["--operation-id"]);
    return submitControl({ kind: args[0], taskId: args[1] }, args);
  }
  if (args[0] === "trace") {
    if (!args[1]) throw new Error("usage: tasks trace TASK_ID");
    validateControlOptions(args.slice(2), []);
    output.log(JSON.stringify(await http.get(`/v1/tasks/${encodeURIComponent(args[1])}/trace`, { baseUrl: BASE, serverId: SERVER_ID })));
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
  const r = await http.get<{ tasks: TaskView[] }>(`/v1/tasks?${q}`, {
    baseUrl: BASE, serverId: SERVER_ID,
    timeoutMs: 5_000,
  });
  if (args.includes("--json")) { output.log(JSON.stringify(r)); return 0; }
  if (r.tasks.length === 0) {
    output.log("(no tasks)");
    return 0;
  }
  output.log(
    ["taskId", "session", "status", "submission", "submittedAt", "elapsedMs", "effort", "effortVerification"].join("\t"),
  );
  for (const t of r.tasks) {
    const elapsed =
      t.completedAt != null ? t.completedAt - t.submittedAt : Date.now() - t.submittedAt;
    output.log(
      [
        t.taskId.slice(0, 8),
        t.session.slice(0, 10),
        t.status,
        t.submissionState,
        new Date(t.submittedAt).toISOString(),
        `${elapsed}ms`,
        effortSummary(t).effort,
        effortSummary(t).verification,
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
  output.log(JSON.stringify(await http.post("/v1/session-controls", { ...body, operationId }, { baseUrl: BASE, serverId: SERVER_ID })));
  return 0;
}

async function cmdShow(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: gpt-relay show <taskId>");
    return 64;
  }
  const t = await getTask(id, BASE, SERVER_ID);
  if (!t) {
    console.error(`task not found: ${id}`);
    return 1;
  }
  if (args.includes("--json")) { output.log(JSON.stringify(t)); return 0; }
  output.log("─── task ───────────────────────────────────────");
  output.log(`  id:          ${t.taskId}`);
  output.log(`  session:     ${t.session}`);
  output.log(`  status:      ${t.status}`);
  output.log(effortDetails(t));
  output.log(`  submission:  ${t.submissionState}`);
  if (t.submissionState === "verifying" && t.submissionVerificationDeadlineAt) {
    output.log(
      `  verify until: ${new Date(t.submissionVerificationDeadlineAt).toISOString()}`,
    );
  }
  if (t.status === "recovering") {
    output.log(`  recovery:    ${t.recoveryReason ?? "deadline exceeded"}`);
    output.log(
      `  lease until: ${t.recoveryLeaseDeadlineAt
        ? new Date(t.recoveryLeaseDeadlineAt).toISOString()
        : "(awaiting extension evidence)"}`,
    );
    output.log(`  hard limit:  ${new Date(t.recoveryDeadlineAt).toISOString()}`);
  }
  output.log(`  submitted:   ${new Date(t.submittedAt).toISOString()}`);
  output.log(
    `  dispatched:  ${t.dispatchedAt ? new Date(t.dispatchedAt).toISOString() : "(pending)"}`,
  );
  output.log(
    `  completed:   ${t.completedAt ? new Date(t.completedAt).toISOString() : "(pending)"}`,
  );
  output.log(`  requeues:    ${t.requeueCount}`);
  if (t.progress) {
    output.log("\n─── progress (provisional) ─────────────────────");
    output.log(`  phase:       ${t.progress.phase}`);
    if (t.progress.activity) output.log(`  activity:    ${t.progress.activity}`);
    output.log(`  outputChars: ${t.progress.outputChars}`);
    output.log(`  changed:     ${new Date(t.progress.changedAt).toISOString()}`);
    output.log(`  observed:    ${new Date(t.progress.observedAt).toISOString()}`);
    output.log("  note:        scheduling signal only; wait for a final reply");
  }
  if (t.text) {
    output.log("\n─── prompt ─────────────────────────────────────");
    output.log(t.text);
  }
  if (t.reply) {
    output.log("\n─── reply ──────────────────────────────────────");
    output.log(t.reply);
  }
  if (t.lateReply) {
    output.log("\n─── late reply ────────────────────────────────");
    output.log(t.lateReply);
  }
  if (t.error) {
    output.log("\n─── error ──────────────────────────────────────");
    output.log(t.error);
    if (t.errorInfo) output.log(JSON.stringify(t.errorInfo));
  }
  if (t.status === "recovering") {
    output.log("\nNOTE: ChatGPT may still be producing this reply. Do not resubmit the prompt.");
    output.log("Use `gpt-relay show` or `gpt-relay resume`, or cancel explicitly.");
  }
  return 0;
}

async function cmdCancel(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error("usage: gpt-relay cancel <taskId>");
    return 64;
  }
  const t = await cancelTask(id, BASE, SERVER_ID);
  output.log(`${t.taskId}: ${t.status}`);
  return 0;
}

async function cmdResume(args: string[]): Promise<number> {
  const rows = await resumePending(BASE, SERVER_ID);
  if (args.includes("--json")) { output.log(JSON.stringify({ results: rows })); return 0; }
  if (rows.length === 0) {
    output.log("(no pending tasks)");
    return 0;
  }
  for (const { record, task, reason } of rows) {
    const preview = record.textPreview.replace(/\s+/g, " ");
    if (!task) {
      if (reason) {
        output.log(`${record.taskId}\t${reason.toUpperCase()}\t${record.baseUrl ?? "unknown backend"}; pending retained`);
        continue;
      }
      if (record.requestOnly) {
        output.log(`${record.session}\tUNCONFIRMED\t"${preview}"; keep request ID ${record.clientRequestId}`);
        continue;
      }
      output.log(`${record.taskId.slice(0, 8)}\tGONE\t"${preview}"`);
      continue;
    }
    const line = [
      task.taskId.slice(0, 8),
      task.status,
      `"${preview}"`,
    ].join("\t");
    output.log(line);
    output.log(effortDetails(task));
    if (task.reply !== null) {
      output.log("─── reply ────────────────");
      output.log(task.reply);
      output.log("──────────────────────────");
    }
    if (task.lateReply) {
      output.log("─── late reply ───────────");
      output.log(task.lateReply);
      output.log("──────────────────────────");
    }
    if (task.status === "recovering") {
      output.log("  note: still awaiting the original reply; do not resubmit");
    }
    if (task.submissionState === "verifying") {
      output.log("  note: verifying whether ChatGPT accepted the original submission");
    }
    if (task.progress) {
      const activity = task.progress.activity ? `, ${task.progress.activity}` : "";
      output.log(
        `  progress: ${task.progress.phase}, ${task.progress.outputChars} chars${activity} (provisional)`,
      );
    }
    if (task.error) output.log(`  error: ${task.error}`);
    if (task.errorInfo) output.log(`  errorInfo: ${JSON.stringify(task.errorInfo)}`);
  }
  return 0;
}

async function cmdReview(args: string[]): Promise<number> {
  let session = "";
  let sessionRef = "";
  let newSession = false;
  let effort: Effort | undefined;
  let effortFallback: EffortPolicy["effortFallback"] | undefined;
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
    else if (a === "--effort") effort = args[++i] as Effort;
    else if (a === "--effort-fallback") effortFallback = args[++i] as EffortPolicy["effortFallback"];
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
    newSession, effort, effortFallback,
    ...(newSession ? { projectId } : {}),
    baseUrl: BASE, serverId: SERVER_ID,
    wait,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    ...(taskTimeoutMs !== undefined ? { taskTimeoutMs } : {}),
    ...(cri !== undefined ? { clientRequestId: cri } : {}),
  });
  if (args.includes("--json")) {
    output.log(JSON.stringify(r));
    return r.reply !== undefined ? reviewExitCode(r) : 0;
  }
  if ("reply" in r && r.reply !== undefined) {
    if (r.effortPolicy) console.error(effortDetails(r));
    output.write(r.reply ?? r.lateReply ?? "");
    const code = reviewExitCode(r);
    if (code !== 0) console.error(`task ${r.taskId} ${r.status}: ${r.error ?? "required effort verification missing"}`);
    if (r.errorInfo) console.error(JSON.stringify({ errorInfo: r.errorInfo }));
    return code;
  }
  output.log(JSON.stringify(r));
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
      "/v1/projects/discover", { save: args.includes("--save") }, { baseUrl: BASE, serverId: SERVER_ID });
    if (!args.includes("--no-wait")) {
      const deadline = Date.now() + 125_000;
      while (["queued", "claimed"].includes(result.status)) {
        if (Date.now() >= deadline) throw new Error(`discovery wait expired; query /v1/projects/discover/${result.discoveryId}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = await http.get(`/v1/projects/discover/${result.discoveryId}`, { baseUrl: BASE, serverId: SERVER_ID });
      }
    }
    output.log(JSON.stringify(result));
    return result.status === "failed" ? 2 : 0;
  }
  if (!action || action === "--json") {
    const result = await http.get<{ projects: Array<{ projectId: string; name: string; description: string | null }> }>("/v1/projects", { baseUrl: BASE, serverId: SERVER_ID });
    if (action === "--json") output.log(JSON.stringify(result));
    else for (const p of result.projects) output.log(`${p.projectId}\t${p.name}\t${p.description ?? ""}`);
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
      ? { description: values["--description"] } : {}) }, { baseUrl: BASE, serverId: SERVER_ID });
  } else if (action === "remove") await http.del(url, { baseUrl: BASE, serverId: SERVER_ID });
  else throw new Error("unknown projects action");
  output.log(JSON.stringify({ status: "ok" }));
  return 0;
}

function usage(): void {
  output.log(`gpt-relay <command>

commands:
  bind [address] [--json]  show binding, or verify and save a server
  bind --local            bind the unique locally registered server
  bind --clear            clear binding while retaining pending tasks
  detect [--local] [--list] [--json]
                           discover servers; bind a unique result or select interactively
  projects [--json]        list local project metadata
  projects set --project-id ID --name NAME [--description TEXT]
  projects remove --project-id ID
  projects discover [--save] [--no-wait]
                           scan visible Project links in open ChatGPT tabs
  start                    start relay server (foreground)
  service install [--dry-run] | status | start | stop | restart | uninstall
                           manage a login service (currently macOS LaunchAgent)
  health                   check the selected relay server
  sessions                 list active ChatGPT sessions
  sessions inspect|suspend|continue --session-ref REF (or --session ID)
  sessions refresh --session-ref REF [--recover-task TASK_ID] [--operation-id ID]
  sessions open --session-ref REF [--instance INSTANCE_ID] [--operation-id ID]
  sessions effort --session-ref REF --effort none|medium|high|max|pro [--effort-fallback error|lower|max] [--operation-id ID]
  sessions close --session-ref REF [--operation-id ID]
                           all session controls also accept --session ID
  doctor [--session-ref REF]  diagnose service, extension and observed DOM
  tasks trace TASK_ID       read durable lifecycle events
  tasks recover|stop|reverify-effort TASK_ID [--operation-id ID]
  operations OPERATION_ID   read asynchronous control result
  tasks [--session ID | --session-ref REF] [--status S] [--last N] [--json]
                           list recent tasks
  show <taskId> [--json]   show prompt, replies and effort verification
  cancel <taskId>          cancel a task
  resume [--json]          check pending tasks from previous run
  review --session ID (--text T | --stdin)
  review --session-ref REF (--text T | --stdin | --file F)
  review --new-session --session-ref REF (--project-id ID | --no-project)
         (--text T | --stdin | --file F) [--no-wait] [--cri KEY]
         [--wait-timeout ms] [--task-timeout ms] [--effort VALUE] [--effort-fallback error|lower|max]
                           submit a review and wait

client output:
  --output <path>          atomically save an exact UTF-8 copy of stdout; stderr stays separate
                           combine with --json for JSON; parent directory must exist
                           existing files are replaced; write failures exit 1

client backend options (temporary; mutually exclusive):
  --server <address>       select an HTTP(S) origin or host:port
  --local                  select the unique locally registered server
  priority: options > GPT_RELAY_URL > binding > discovery
  an unavailable selected server never causes automatic switching

env:
  GPT_RELAY_HOST              server bind host (127.0.0.1)
  GPT_RELAY_PORT (${PORT})     server port
  GPT_RELAY_URL                client backend override
  GPT_RELAY_CLIENT_CONFIG      binding file (~/.gpt-relay/client.json)
  GPT_RELAY_REGISTRY_DIR       local server registry (~/.gpt-relay/servers)
  GPT_RELAY_DISCOVERY          0 disables LAN mDNS; local registry still works
  GPT_RELAY_PENDING_DIR        agent pending records dir
`);
}

async function dispatch(cmd: string | undefined, rest: string[], options: BackendOptions): Promise<number> {
  if (cmd === "bind") return await cmdBind(rest, options);
  if (cmd === "detect") return await cmdDetect(rest, options);
  const business = ["health", "doctor", "sessions", "projects", "tasks", "operations", "show", "cancel", "resume", "review"];
  if (business.includes(cmd ?? "")) {
    validateBusinessArgs(cmd!, rest);
    const backend = await resolveBackend(options);
    BASE = backend.baseUrl; SERVER_ID = backend.serverId;
  } else if (options.server || options.local) throw new BackendError("invalid_arguments", "backend options apply to client commands, not start or help");
  switch (cmd) {
    case "start":
      return await cmdStart(rest);
    case "service":
      await (await import("../service/index.js")).serviceCommand(rest);
      return 0;
    case "health":
      return await cmdHealth();
    case "doctor": {
      validateControlOptions(rest, ["--session", "--session-ref"]);
      const i = rest.findIndex(x => x === "--session" || x === "--session-ref");
      if (i >= 0 && !rest[i + 1]) throw new Error("missing session");
      const result = await http.get<{ status: string }>(`/v1/doctor${i < 0 ? "" : `?session=${encodeURIComponent(rest[i + 1]!)}`}`, { baseUrl: BASE, serverId: SERVER_ID });
      output.log(JSON.stringify(result));
      return result.status === "ok" ? 0 : 2;
    }
    case "sessions":
      return await cmdSessions(rest);
    case "projects":
      return await cmdProjects(rest);
    case "tasks":
      return await cmdTasks(rest);
    case "operations":
      if (!rest[0]) throw new Error("usage: operations OPERATION_ID");
      validateControlOptions(rest.slice(1), []);
      output.log(JSON.stringify(await http.get(`/v1/operations/${encodeURIComponent(rest[0])}`, { baseUrl: BASE, serverId: SERVER_ID })));
      return 0;
    case "show":
      return await cmdShow(rest);
    case "cancel":
      return await cmdCancel(rest);
    case "resume":
      return await cmdResume(rest);
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
}

async function main(): Promise<number> {
  let cmd: string | undefined, rest: string[] = [];
  try {
    const parsed = parseGlobalOptions(process.argv.slice(2));
    [cmd, ...rest] = parsed.args;
    if (parsed.output !== undefined) {
      if (!["bind", "detect", "health", "doctor", "sessions", "projects", "tasks", "operations", "show", "cancel", "resume", "review"].includes(cmd ?? "")) {
        throw new BackendError("invalid_arguments", "--output applies only to client commands");
      }
      output.prepare(parsed.output);
    }
    const code = await dispatch(cmd, rest, parsed.options);
    output.commit(code);
    return code;
  } catch (err) {
    output.abort();
    const controlCommand = ["doctor", "operations"].includes(cmd ?? "") ||
      cmd === "sessions" && ["inspect", "suspend", "continue", "refresh", "open", "close", "effort"].includes(rest[0] ?? "") ||
      cmd === "tasks" && ["trace", "recover", "stop", "reverify-effort"].includes(rest[0] ?? "");
    if (err instanceof OutputWriteError) {
      if (process.argv.includes("--json") || controlCommand) console.error(JSON.stringify({ error: err.code, message: err.message,
        errorInfo: { code: err.code, message: err.message, deliveryState: "unknown", safeToResubmit: null,
          nextAction: "inspect_operation_or_existing_task_before_retry" } }));
      else console.error(`error: ${err.code}: ${err.message}`);
      return 1;
    }
    if (err instanceof BackendError) {
      const code = controlCommand && err.code === "invalid_arguments" ? "client_error" : err.code;
      if (process.argv.includes("--json") || controlCommand) console.error(JSON.stringify({ error: code, message: err.message, candidates: err.candidates, probe: err.probe,
        errorInfo: { code, message: err.message, deliveryState: "unknown", safeToResubmit: null } }));
      else {
        console.error(`error: ${err.code}: ${err.message}`);
        if (err.probe) console.error(JSON.stringify({ probe: err.probe }));
        for (const backend of err.candidates ?? []) console.error(`  ${backend.name}\t${backend.baseUrl}\t${backend.serverId ?? "legacy"}`);
      }
      return !controlCommand && ["invalid_arguments", "invalid_backend"].includes(err.code) ? 64 : 1;
    }
    if (rest.includes("--json") || controlCommand) {
      console.error(JSON.stringify({ error: err instanceof HttpError ? err.code : "client_error",
        errorInfo: err instanceof HttpError && err.errorInfo ? err.errorInfo : {
          code: "client_error", message: (err as Error).message, deliveryState: "unknown",
          safeToResubmit: null, nextAction: "inspect_operation_or_existing_task_before_retry" } }));
    } else console.error(`error: ${(err as Error).message}`);
    return 1;
  }
}

main().then((code) => { process.exitCode = code; });
