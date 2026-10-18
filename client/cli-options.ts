import { BackendError } from "./backend.js";
import type { BackendOptions } from "./backend-resolver.js";

const VALUES = new Set(["--session", "--session-ref", "--operation-id", "--recover-task", "--instance", "--status",
  "--last", "--project-id", "--name", "--description", "--text", "--file", "--timeout", "--wait-timeout", "--task-timeout", "--cri", "--effort", "--effort-fallback"]);
export function parseGlobalOptions(argv: string[]): { args: string[]; options: BackendOptions } {
  const args: string[] = [], options: BackendOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--server") {
      if (options.server !== undefined || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw new BackendError("invalid_arguments", "provide exactly one --server address");
      options.server = argv[++i];
    } else if (arg === "--local") {
      if (options.local) throw new BackendError("invalid_arguments", "duplicate --local");
      options.local = true;
    } else {
      args.push(arg);
      if (VALUES.has(arg) && argv[i + 1] !== undefined) args.push(argv[++i]!);
    }
  }
  if (options.server && options.local) throw new BackendError("invalid_arguments", "--server and --local are mutually exclusive");
  return { args, options };
}

export function validateBusinessArgs(command: string, args: string[]): void {
  let start = 0, flags: string[] = [], values: string[] = [];
  switch (command) {
    case "health": break;
    case "doctor": values = ["--session", "--session-ref"]; break;
    case "sessions":
      if (["inspect", "suspend", "continue", "refresh", "open", "close", "effort"].includes(args[0] ?? "")) {
        start = 1; values = ["--session", "--session-ref"];
        if (["refresh", "open", "close", "effort"].includes(args[0]!)) values.push("--operation-id");
        if (args[0] === "effort") values.push("--effort", "--effort-fallback");
        if (args[0] === "refresh") values.push("--recover-task");
        if (args[0] === "open") values.push("--instance");
      } else values = ["--session-ref"];
      break;
    case "tasks":
      if (["trace", "recover", "stop", "reverify-effort"].includes(args[0] ?? "")) {
        if (!args[1] || args[1].startsWith("--")) throw new BackendError("invalid_arguments", "tasks control requires a task ID");
        start = 2; if (args[0] !== "trace") values = ["--operation-id"];
      } else values = ["--session", "--session-ref", "--status", "--last"];
      break;
    case "operations": case "show": case "cancel":
      if (!args[0] || args[0].startsWith("--")) throw new BackendError("invalid_arguments", `${command} requires an ID`);
      start = 1; break;
    case "resume": break;
    case "review":
      flags = ["--new-session", "--no-project", "--stdin", "--no-wait"];
      values = ["--session", "--session-ref", "--project-id", "--text", "--file", "--timeout", "--wait-timeout", "--task-timeout", "--cri", "--effort", "--effort-fallback"];
      break;
    case "projects":
      if (args[0] === "discover") { start = 1; flags = ["--save", "--no-wait"]; }
      else if (["set", "remove"].includes(args[0] ?? "")) {
        start = 1; values = ["--project-id", "--name", "--description"];
      } else if (args.length && args[0] !== "--json") throw new BackendError("invalid_arguments", "unknown projects action");
      break;
  }
  flags.push("--json");
  const seen = new Set<string>();
  for (let i = start; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || !flags.includes(flag) && !values.includes(flag)) throw new BackendError("invalid_arguments", `invalid or duplicate option: ${flag}`);
    seen.add(flag);
    if (values.includes(flag)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--") && !["--text", "--description"].includes(flag)) throw new BackendError("invalid_arguments", `missing value: ${flag}`);
      if (["--timeout", "--wait-timeout", "--task-timeout", "--last"].includes(flag) && (!Number.isFinite(Number(value)) || Number(value) <= 0)) throw new BackendError("invalid_arguments", `invalid value: ${flag}`);
    }
  }
  if (seen.has("--session") && seen.has("--session-ref")) throw new BackendError("invalid_arguments", "provide exactly one session selector");
  if (command === "sessions" && start === 1 && !seen.has("--session") && !seen.has("--session-ref")) {
    throw new BackendError("invalid_arguments", "session control requires --session or --session-ref");
  }
  if (command === "review" && (seen.has("--session") === seen.has("--session-ref") ||
      ["--text", "--stdin", "--file"].filter(flag => seen.has(flag)).length !== 1 ||
      seen.has("--new-session") && (!seen.has("--session-ref") || seen.has("--project-id") === seen.has("--no-project")))) {
    throw new BackendError("invalid_arguments", "review requires exactly one session selector, input and an explicit project choice for a new session");
  }
  if ((seen.has("--effort") || seen.has("--effort-fallback")) &&
      (command === "review" && !seen.has("--new-session") || !seen.has("--effort"))) {
    throw new BackendError("invalid_arguments", "effort requires a new session or sessions effort");
  }
  if (command === "sessions" && args[0] === "effort" && !seen.has("--effort"))
    throw new BackendError("invalid_arguments", "sessions effort requires --effort");
  for (const [flag, allowed] of [["--effort", ["none", "medium", "high", "max", "pro"]],
      ["--effort-fallback", ["error", "lower", "max"]]] as const) {
    if (seen.has(flag) && !(allowed as readonly string[]).includes(args[args.indexOf(flag) + 1]!))
      throw new BackendError("invalid_arguments", `invalid value: ${flag}`);
  }
  if (seen.has("--effort-fallback") && args[args.indexOf("--effort-fallback") + 1] === "max" &&
      args[args.indexOf("--effort") + 1] !== "pro")
    throw new BackendError("invalid_arguments", "max fallback requires --effort pro");
  if (command === "projects" && ["set", "remove"].includes(args[0] ?? "") &&
      (!seen.has("--project-id") || args[0] === "set" && !seen.has("--name"))) {
    throw new BackendError("invalid_arguments", "projects requires an ID and set requires a name");
  }
}
