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

## Applicability and proportionality

Before admitting any agent, relay, CI, or GitHub finding as a blocker, the agent must establish:

1. **Authority** — the current issue, repository policy, approved design, user instruction, or another binding source requires it; or verified evidence proves a correctness, security, privacy, data, or operational failure.
2. **Current exposure** — identify the real current or committed near-term consumer, persisted artifact, interoperability boundary, deployment, release commitment, or protected asset affected now; a hypothetical future consumer is insufficient.
3. **Concrete failure** — state what fails if the requirement is omitted in the current artifact.
4. **Timing and scope** — explain why the current issue, plan, or PR must address it rather than a later release gate or follow-up.
5. **Minimum sufficient measure** — explain why a simpler, reversible, or narrower solution is insufficient.

Assess project maturity from repository and user evidence: release state, real consumers, persisted production data, compatibility/versioning commitments, reversibility, failure cost, security or regulatory boundaries, and the current milestone's purpose. A maturity label is neither proof of exposure nor a blanket exemption. A pre-release project may still need a small internal format discriminator or safety invariant, but it does not inherit full release-grade versioning, migration, deprecation, or operational machinery without evidence.

A generally sound best practice that fails this test is not a current blocker. Mark it `deferred`, `out-of-scope`, or `rejected` with evidence and, when useful, record the release condition that would make it applicable. Relay may challenge the agent's assessment, but repetition or stronger wording is not new evidence. If an explicit frozen contract itself appears materially disproportionate, do not silently ignore or reinterpret it; record one contract-applicability challenge and use the active workflow's user-decision rule.

## Finding ledger

After the initial response, maintain stable finding IDs and record:

| Field | Required content |
|---|---|
| Classification | Why the finding is admissible and blocking or non-blocking |
| Basis | Acceptance criterion, contract, code path, test, CI result, or other authoritative source |
| Applicability | `required-now`, `defer`, or `not-applicable`; blockers and disputed findings include current exposure, concrete failure, timing, and scope evidence |
| Problem model | Violated invariant or root cause, affected in-scope surface, and whether the reported location is isolated or representative |
| Minimum sufficient measure | For `required-now`, the narrowest adequate correction; otherwise why no current change is required and, when useful, the future activation condition |
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

Timing alone neither admits nor waives a blocker. Verify relay claims against authoritative repository evidence and apply the applicability test independently. Fix a real in-scope blocker with the minimum sufficient measure, record or defer non-blocking work, reject unsupported or context-inapplicable claims with evidence, and never expand scope silently.

## Problem-level remediation

Before correcting an admitted finding, analyze the underlying problem rather than patching only the literal location described by the comment. Identify the violated invariant or root cause, reproduce or trace the concrete failure, and inspect the in-scope code paths, input classes, state transitions, and sibling artifacts governed by the same mechanism. Group findings that are different manifestations of the same cause into one correction set.

The correction must address the evidenced problem class at the minimum sufficient scope. Verification must cover the reported trigger and representative same-cause cases where applicable.

“Comprehensive” does not authorize unrestricted refactoring or scope expansion. Related work outside the current artifact's authority or scope must be recorded as `deferred` or `out-of-scope` with supporting evidence.

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
