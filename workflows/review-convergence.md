# Bounded review convergence

Shared rules for bounded Relay review: round accounting, finding lineage, applicability, and continuation. Each workflow owns its artifact-specific evidence, verdicts, checkpoints, submission timing, and targeted closure exceptions.

Resolve and inherit Relay effort under the shared [workflow effort policy](./README.md#relay-effort-policy). An effort change or fallback neither resets a cycle nor replaces pending tasks.

## Review budget

Allow at most three full substantive submissions: initial comprehensive review, correction/regression review, and final convergence. Never start a fourth unrestricted review or treat exhausted budget as approval.

A round is consumed only by a substantive review of the requested artifact. Access failure, pause, captcha, transport failure, clearly truncated output, and off-topic replies are execution failures under [`agent-instructions.md`](../agent-instructions.md); this distinction never permits automatic retry of paused or rate-limited sessions.

Where a workflow combines Relay with CI or GitHub feedback, all declared sources share one ledger and continuation decision; non-Relay gates create no separate review budget. The workflow defines correction/completion barriers and feedback cutoffs.

The initial submission requests all currently identifiable blockers. The second includes the current artifact, complete ledger, revision summary, and relevant versions or diff, and reconciles prior IDs. The third uses final convergence scope. Later findings, artifact changes, deterministic corrections, and `auto` never reset a cycle. A new cycle requires the active workflow's explicit condition or direct user authorization; retain the ledger and record the reason.

## Revision evidence and workflow readiness

Bind submissions, results, and verification to exact artifact revisions or heads. A Relay verdict does not satisfy CI, execution-proof, publication, or handoff gates. Pending proof is unverified, neither a pass nor evidence of failure; the workflow determines what must precede review.

When the workflow permits early candidate replacement, mark the old revision superseded and retain task IDs, results, pending/cancelled verification, and finding lineage. Its substantive review still consumes a round even if CI fails. Supersession and cancellation never refund rounds, reset the ledger, resolve blockers, or approve incomplete evidence.

Attach late findings to their source revision, verify current applicability, and carry unresolved problems under the same IDs. Old-revision evidence cannot prove a current correction. Follow the workflow's observation cutoff and revalidation rules; do not monitor indefinitely or bypass unresolved risk.

## Applicability and proportionality

Before admitting any agent, Relay, CI, or GitHub finding as a blocker, establish:

1. **Authority**: a binding issue, policy, design, user instruction, or verified correctness/security/privacy/data/operational failure.
2. **Current exposure**: a real current or committed near-term consumer, persisted artifact, interoperability boundary, deployment, release commitment, or protected asset; hypothetical future use is insufficient.
3. **Concrete failure**: what fails if the requirement is omitted.
4. **Timing and scope**: why this artifact must address it now rather than at a later gate or follow-up.
5. **Minimum sufficient measure**: why a simpler, reversible, or narrower correction is insufficient.

Record or refresh a concise **project constraint profile** from repository and user evidence: release state and milestone purpose; current/committed near-term consumers and deployments; production data or long-lived artifacts; compatibility/versioning commitments; reversibility and failure cost; security, privacy, and regulatory boundaries. Include only dimensions affecting the current decision. Maturity is evidence, neither exposure proof nor a blanket exemption: pre-release work may need a small format discriminator or safety invariant without full release-grade versioning, migration, deprecation, or operations.

Best practices failing this test are `deferred`, `out-of-scope`, or `rejected`, with evidence and useful future activation conditions. Repetition or stronger wording is not new evidence. If a frozen requirement is materially disproportionate, record one contract-applicability challenge and use the workflow's user-decision rule; never silently ignore or reinterpret it.

## Review prompt assembly

For workflow prompts that reference this base, include the following text in the actual submitted prompt, followed by the stage's review instructions, required inputs, evidence, and exact verdict set. A local link alone does not give Relay these rules.

```text
Evaluate applicability before severity. A blocker requires a binding contract
or policy, or a verified current failure. Give its stable ID, authoritative
basis, current exposure, concrete failure, why this artifact must address it
now, and minimum sufficient correction; explain why a simpler reversible
measure is insufficient. A generic best practice is not a blocker.

Use the project constraint profile as evidence, not a blanket exemption.
Identify unsupported release-grade versioning, migration, compatibility,
deprecation, abstraction, or operations and propose the minimum sufficient
alternative. Separate blockers from wording, style, optional hardening, and
follow-ups. Reconcile prior IDs; do not reopen resolved, rejected, or deferred
findings without new evidence.
```

An initial review requests the complete blocker set. Final convergence reviews only unresolved ledger findings, blocker-level revision regressions, new authoritative evidence, and proven critical late findings; it never restarts broad review or requests another full submission. Include the stage's critical-late-finding evidence requirements, complete current artifact or accessible remote exact revision, constraint profile, validation evidence, and round-specific ledger/summary/diff. Independent discussion and targeted closure use their own narrower instructions.

## Finding ledger

Maintain stable IDs after the initial response:

| Field | Required content |
|---|---|
| Classification | Why admissible and blocking/non-blocking |
| Basis | Authoritative criterion, contract, code, test, CI result, or other source |
| Applicability | `required-now`, `defer`, or `not-applicable`; blockers/disputes include exposure, failure, timing, and scope |
| Problem model | Violated invariant/root cause, affected in-scope surface, and isolated versus representative location |
| Minimum sufficient measure | Narrowest adequate correction, or reason no current change is required and useful future activation condition |
| Status | `open`, `resolved`, `rejected`, `deferred`, or `disputed` |
| Artifact lineage | Reviewed revision/head and applicable correction revision/head |
| Disposition | Agent action and verification evidence |

Classify later findings as `revision-regression` (latest revision caused it), `new-evidence` (authoritative evidence not reasonably available earlier), `critical-late-finding` (discoverable earlier, now proven required-contract violation or severe failure under the workflow's high proof burden), `late-nonblocking` (optional or low-impact work), `out-of-scope`, or, where supported, `user-decision` (material trade-off outside agent authority).

Timing neither admits nor waives a blocker. Verify Relay claims locally, independently apply applicability, fix real in-scope blockers with the minimum sufficient measure, and record/defer/reject other claims with evidence. Never silently expand scope.

## Problem-level remediation

Before correcting an admitted finding, identify the violated invariant/root cause, reproduce or trace the failure, and inspect in-scope paths, input classes, state transitions, and sibling artifacts governed by the same mechanism. Group same-cause manifestations into one correction set rather than patching only the literal commented location.

Correct the evidenced problem class at minimum sufficient scope. Verify the reported trigger and representative same-cause cases. Record related work outside authority/scope as `deferred` or `out-of-scope`; comprehensive analysis does not authorize unrestricted refactoring.

## Final convergence and continuation

Use the workflow's exact final verdict set and the restricted final scope above. The agent makes the semantic continuation decision:

- No verified admissible blocker: continue through remaining workflow gates.
- Deterministic correction explicitly permitted by the workflow: correct, verify, and update the ledger without another unrestricted review.
- Authority blocker or absolute disagreement: selected mode's consolidated checkpoint or `BLOCKED_HANDOFF`.
- Fundamental redesign or fresh broad review: the workflow's escalation rule; no automatic reset.

In `auto`, record the following without asking Relay separately whether execution may continue:

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

Mode changes checkpoints, not rigor. Fix accepted blockers without routine approval; unsupported preferences do not block. Unresolved authority, absolute disagreement, or inability to obtain a required clean verdict produces one consolidated `BLOCKED_HANDOFF`, never automatic budget extension.
