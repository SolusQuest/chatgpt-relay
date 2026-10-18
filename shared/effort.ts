export const EFFORTS = ["none", "medium", "high", "max", "pro"] as const;
export type Effort = typeof EFFORTS[number];
export interface EffortPolicy { effort: Effort; effortFallback: "error" | "lower" | "max" }
export interface EffortSelection {
  requestedEffort: Effort; effectiveEffort: Effort; fallbackApplied: boolean; modelFamily: string;
}
export const EVIDENCE_REASONS = ["timeout", "network_error", "http_error", "auth_unavailable", "unsupported_history", "turn_not_found", "reply_not_finished", "metadata_missing", "identity_changed", "script_failed", "missing_turn_ids", "missing_evidence", "unsupported_model"] as const;
export interface EffortVerification {
  reason?: typeof EVIDENCE_REASONS[number];
  attempts?: number;
  httpStatus?: number;
  submittedUserMessageId?: string;
  assistantMessageId?: string;
  checkedAt?: number;
  status: "verified" | "mismatch" | "unknown"; model: string | null; thinkingEffort: string | null;
}
export function parseEffortPolicy(body: { effort?: unknown; effortFallback?: unknown }): EffortPolicy | null {
  if (body.effort === undefined && body.effortFallback === undefined) return null;
  if (!EFFORTS.includes(body.effort as Effort) ||
      body.effortFallback !== undefined && !["error", "lower", "max"].includes(body.effortFallback as string) ||
      body.effortFallback === "max" && body.effort !== "pro") {
    throw new Error("invalid_effort_policy");
  }
  return { effort: body.effort as Effort, effortFallback: body.effortFallback as EffortPolicy["effortFallback"] ?? "error" };
}
export function validSelection(policy: EffortPolicy, s: EffortSelection): boolean {
  if (!s || s.requestedEffort !== policy.effort || !EFFORTS.includes(s.effectiveEffort) ||
      !["GPT-6", "GPT-5.6 Sol"].includes(s.modelFamily)) return false;
  const changed = s.effectiveEffort !== policy.effort;
  return s.fallbackApplied === changed && (!changed ||
    policy.effort === "pro" && policy.effortFallback === "max" && s.effectiveEffort === "max" ||
    policy.effortFallback === "lower" &&
    policy.effort !== "pro" && s.effectiveEffort !== "pro" &&
    EFFORTS.indexOf(s.effectiveEffort) < EFFORTS.indexOf(policy.effort));
}
export function verifyEffort(s: EffortSelection | null, evidence: unknown): EffortVerification {
  const e = evidence as Record<string, unknown> | null;
  const detail: Partial<EffortVerification> = {};
  if (EVIDENCE_REASONS.includes(e?.reason as typeof EVIDENCE_REASONS[number])) detail.reason = e!.reason as EffortVerification["reason"];
  if (Number.isInteger(e?.attempts) && Number(e?.attempts) >= 1 && Number(e?.attempts) <= 3) detail.attempts = Number(e!.attempts);
  if (Number.isInteger(e?.httpStatus) && Number(e?.httpStatus) >= 100 && Number(e?.httpStatus) <= 599) detail.httpStatus = Number(e!.httpStatus);
  for (const key of ["submittedUserMessageId", "assistantMessageId"] as const)
    if (typeof e?.[key] === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(e[key] as string)) detail[key] = e[key] as string;
  const model = typeof e?.model === "string" && e.model.length < 100 ? e.model : null;
  const thinkingEffort = typeof e?.thinkingEffort === "string" && e.thinkingEffort.length < 50 ? e.thinkingEffort : null;
  if (!s || !model) return { ...detail, reason: detail.reason ?? (!model ? "missing_evidence" : "metadata_missing"), status: "unknown", model, thinkingEffort };
  const match = model.match(/^gpt-(6|5[.-]6)(-thinking|-pro)?$/);
  if (!match) return { ...detail, reason: "unsupported_model", status: "unknown", model, thinkingEffort };
  const family = match[1] === "6" ? "GPT-6" : "GPT-5.6 Sol";
  if (family !== s.modelFamily) {
    delete detail.reason;
    return { ...detail, status: "mismatch", model, thinkingEffort };
  }
  let matches = true;
  if (s.effectiveEffort === "pro") matches &&= match[2] === "-pro";
  else if (s.effectiveEffort === "none") matches &&= !match[2];
  else {
    if (match[2] === "-thinking" && !thinkingEffort) return { ...detail, reason: detail.reason ?? (!model ? "missing_evidence" : "metadata_missing"), status: "unknown", model, thinkingEffort };
    const expected = { medium: "standard", high: "extended", max: "max" }[s.effectiveEffort];
    matches &&= match[2] === "-thinking" && thinkingEffort === expected;
  }
  delete detail.reason;
  return { ...detail, status: matches ? "verified" : "mismatch", model, thinkingEffort };
}
