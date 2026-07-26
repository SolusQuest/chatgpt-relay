# Bounded review convergence

This is the shared protocol for workflow phases that declare a bounded relay review. It defines round accounting, finding lineage, and continuation rules. Each workflow still owns its artifact-specific prompt, evidence standard, verdicts, checkpoints, and any targeted closure procedure.

## Review budget

A bounded artifact review allows at most three full submissions:

1. Initial comprehensive review.
2. Correction and regression review.
3. Final convergence review.

A submission consumes a round only when relay returns a substantive review of the requested artifact. URL-access failure, pause, captcha, transport failure, clearly truncated output, or an off-topic response is an execution failure; follow [`agent-instructions.md`](../agent-instructions.md) recovery rules and never use this distinction to retry a paused or rate-limited session automatically.

An active workflow may define a convergence round as that relay submission plus synchronized non-relay gates for the same artifact revision, such as CI and GitHub feedback. Those gates do not create separate relay budgets. The workflow owns their completion barrier and cutoff; findings from every declared source share one ledger and one continuation decision.

Ask the initial review for the complete set of currently identifiable blockers. The second submission includes the current artifact, finding ledger, revision summary, and the relevant artifact versions or diff. Relay must reconcile prior finding IDs rather than silently rename or reopen them. The third submission uses the workflow's final-convergence prompt and is not another unrestricted restart.

Do not reset the budget because relay introduces a later finding, the artifact changes, a deterministic correction is made, or the workflow uses `auto`. A new full review cycle requires the explicit condition stated by the active workflow or direct user authorization; carry the prior ledger forward and record why the cycle changed.

Never start a fourth unrestricted review. The limit bounds re-review; it never makes a real blocker non-blocking or turns exhausted budget into approval.

## Finding ledger

After the initial response, maintain stable finding IDs and record:

| Field | Required content |
|---|---|
| Classification | Why the finding is admissible and blocking or non-blocking |
| Basis | Acceptance criterion, contract, code path, test, CI result, or other authoritative source |
| Status | `open`, `resolved`, `rejected`, `deferred`, or `disputed` |
| Artifact lineage | Reviewed revision or head and, when applicable, correction revision or head |
| Disposition | Agent action and verification evidence |

Classify a finding first raised after the initial review as:

- `revision-regression` — directly introduced by the latest revision.
- `new-evidence` — supported by authoritative evidence not reasonably available earlier.
- `critical-late-finding` — discoverable earlier, but now proven to violate the artifact's required contract or create a severe failure. It must satisfy the workflow's high burden of proof.
- `late-nonblocking` — a preference, optional hardening, low-impact risk, or follow-up that is not required for the current gate.
- `out-of-scope` — valid work not required for the current artifact to be correct.
- `user-decision` — when supported by the phase, a product or material trade-off the agent is not authorized to settle.

Timing alone neither admits nor waives a blocker. Verify relay claims against authoritative repository evidence. Fix a real in-scope blocker, record or defer non-blocking work, reject unsupported claims with evidence, and never expand scope silently.

## Final convergence and continuation

The final convergence review considers only unresolved ledger findings, blocker-level regressions caused by the latest revision, new authoritative evidence, and proven critical late findings. It must use the workflow's exact verdict set.

After the final response, the agent makes the semantic decision:

- No agent-verified admissible blocker remains → continue.
- A real blocker has a deterministic correction explicitly permitted by the workflow → make the minimum correction, verify it, update the ledger, and continue without another unrestricted review.
- An authority blocker or absolute disagreement remains → use the selected execution mode's consolidated checkpoint or `BLOCKED_HANDOFF`.
- Fundamental problems require a fresh broad review or artifact redesign → do not reset automatically; use the active workflow's escalation rule.

In `auto`, do not send relay a separate request asking whether execution may continue. Record:

```text
Decision: CONTINUE | BLOCKED_HANDOFF
Phase: <phase>
Relay verdict: <verdict>
Open verified blocker IDs: <ids or none>
Authority blocker: yes | no
Absolute disagreement: yes | no
Evidence: <authoritative source or reproduction>
Next action: <action>
```

Execution mode changes checkpoint behavior, not review rigor. A real accepted blocker is fixed without a routine user checkpoint; an unsupported preference does not block; and an unresolved authority blocker, absolute disagreement, or required clean-verdict failure ends in one consolidated `BLOCKED_HANDOFF` rather than an automatic budget extension.
