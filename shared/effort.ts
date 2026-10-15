export const EFFORTS = ["none", "medium", "high", "max", "pro"] as const;
export type Effort = typeof EFFORTS[number];
export interface EffortPolicy { effort: Effort; effortFallback: "error" | "lower" }
export interface EffortSelection {
  requestedEffort: Effort; effectiveEffort: Effort; fallbackApplied: boolean; modelFamily: string;
}
export interface EffortVerification {
  status: "verified" | "mismatch" | "unknown"; model: string | null; thinkingEffort: string | null;
}
export function parseEffortPolicy(body: { effort?: unknown; effortFallback?: unknown }): EffortPolicy | null {
  if (body.effort === undefined && body.effortFallback === undefined) return null;
  if (!EFFORTS.includes(body.effort as Effort) ||
      body.effortFallback !== undefined && !["error", "lower"].includes(body.effortFallback as string)) {
    throw new Error("invalid_effort_policy");
  }
  return { effort: body.effort as Effort, effortFallback: body.effortFallback as "error" | "lower" ?? "error" };
}
export function validSelection(policy: EffortPolicy, s: EffortSelection): boolean {
  if (!s || s.requestedEffort !== policy.effort || !EFFORTS.includes(s.effectiveEffort) ||
      !["GPT-6", "GPT-5.6 Sol"].includes(s.modelFamily)) return false;
  const changed = s.effectiveEffort !== policy.effort;
  return s.fallbackApplied === changed && (!changed || policy.effortFallback === "lower" &&
    policy.effort !== "pro" && s.effectiveEffort !== "pro" &&
    EFFORTS.indexOf(s.effectiveEffort) < EFFORTS.indexOf(policy.effort));
}
export function verifyEffort(s: EffortSelection | null, evidence: unknown): EffortVerification {
  const e = evidence as { model?: unknown; thinkingEffort?: unknown } | null;
  const model = typeof e?.model === "string" && e.model.length < 100 ? e.model : null;
  const thinkingEffort = typeof e?.thinkingEffort === "string" && e.thinkingEffort.length < 50 ? e.thinkingEffort : null;
  if (!s || !model) return { status: "unknown", model, thinkingEffort };
  const match = model.match(/^gpt-(6|5[.-]6)(-thinking|-pro)?$/);
  if (!match) return { status: "unknown", model, thinkingEffort };
  const family = match[1] === "6" ? "GPT-6" : "GPT-5.6 Sol";
  let matches = family === s.modelFamily;
  if (s.effectiveEffort === "pro") matches &&= match[2] === "-pro";
  else if (s.effectiveEffort === "none") matches &&= !match[2];
  else {
    if (match[2] === "-thinking" && !thinkingEffort) return { status: "unknown", model, thinkingEffort };
    const expected = { medium: "standard", high: "extended", max: "max" }[s.effectiveEffort];
    matches &&= match[2] === "-thinking" && thinkingEffort === expected;
  }
  return { status: matches ? "verified" : "mismatch", model, thinkingEffort };
}
