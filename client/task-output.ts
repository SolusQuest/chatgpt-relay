import type { ReviewResult, TaskView } from "./agent-client.js";

type EffortTask = Pick<TaskView, "status" | "effortPolicy" | "effortSelection" | "effortVerification">;
const terminal = new Set(["done", "failed", "cancelled", "expired"]);

export function effortSummary(task: EffortTask) {
  if (!task.effortPolicy) return { effort: "disabled", verification: "disabled" };
  const selected = task.effortSelection;
  return {
    effort: `${task.effortPolicy.effort}->${selected?.effectiveEffort ?? (terminal.has(task.status) ? "not_selected" : "pending")}${selected?.fallbackApplied ? " (fallback)" : ""}`,
    verification: task.effortVerification?.status ?? (terminal.has(task.status) ? "not_checked" : "pending"),
  };
}

export function effortDetails(task: EffortTask): string {
  const summary = effortSummary(task);
  const lines = [`  effort:      ${summary.effort}`, `  effort verify: ${summary.verification}`];
  if (task.effortPolicy) lines.push(`  fallback:    ${task.effortPolicy.effortFallback}`);
  if (task.effortSelection) lines.push(`  family:      ${task.effortSelection.modelFamily}`);
  if (task.effortVerification) {
    lines.push(`  model:       ${task.effortVerification.model ?? "(unknown)"}`);
    lines.push(`  thinking:    ${task.effortVerification.thinkingEffort ?? "(not reported)"}`);
  }
  return lines.join("\n");
}

export function reviewExitCode(result: ReviewResult): number {
  if (result.effortPolicy && result.effortVerification?.status !== "verified") return 2;
  return result.status === "done" || (result.status === "failed" && typeof result.lateReply === "string") ? 0 : 2;
}
