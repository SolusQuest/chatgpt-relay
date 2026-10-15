# Workflow: Implementation

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Effort defaults, fallback and inheritance: [Relay effort policy](./README.md#relay-effort-policy)
- [Execution modes](./README.md#execution-modes), [session selection](./README.md#relay-session-selection), and [stage handoffs/reference loading](./README.md#stage-handoffs-and-delegation)
- Review protocol and prompt base: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`plan.md`](./plan.md): handoff mismatch/material plan deviation; a valid reviewed handoff needs no procedure reread.
- [`issue-to-pr.md`](./issue-to-pr.md) or [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): coordinating the selected composition; delegated Implementation inherits invocation/authority through the handoff.

## Purpose and routing

Consume a reviewed implementation/test plan, implement/validate, publish a draft PR, converge CI/GitHub/Relay, confirm initial exact-gate ready promotion, and hand off. Standalone and composed use end at `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.

Without a usable reviewed plan, route to Plan/composition. A summary is not plan-review proof; unknown readiness blocks coding. Exclude exploration, trivial edits whose review overhead exceeds risk, and work where the user declines Relay.

## Preconditions and handoff validation

- Accessible frozen issue, complete reviewed plan/shared handoff, instructions/contracts, and dependencies.
- Separate user authority for implementation, branch publication, draft PR, Relay, and initial exact-gate promotion; `PLAN_READY` grants none.
- Resolve/inherit mode/session and require usability before submissions; preserve identity, ledger, established budgets, and fallback record.

Before editing, verify artifact revisions, review disposition/continuation, repository baseline/working-tree state, instructions, and dependencies against the handoff. Reuse applicable prior work; agent changes or elapsed time alone trigger no new plan cycle. Concrete changed evidence affecting applicability returns to Plan under existing authority/budgets, without an extra routine review/approval gate.

Plan owns [readiness fallback](./plan.md#automatic-readiness-fallback), eligible only before implementation and under its conditions. Implementation never invokes Design directly or regains fallback after coding; use the deviation rule below.

## Phase 1 — Implement and validate

Implement production behavior and tests together within the frozen issue. Use focused/static checks during iteration and small semantic commits when required. Verify every acceptance criterion against code/tests; demonstrate bug regressions before fixing when practical, and directly cover new behavior's acceptance/failure paths. Artificial naive/no-op evidence is insufficient.

Pass repository-mandated local checks, relevant build/static/fast/focused/contract/fixture tests, and required target-platform execution on changed/previously failing paths before review, under the [submission policy](#review-submission-and-ci-scheduling). Record broader CI validation and outstanding required E2E/manual proof; complete all before final readiness.

Update implementation-local plan details without changing scope. Add only admitted requirements/minimum corrections, not machinery solely recommended by Relay.

Material architecture/public-contract/migration/security/test-strategy changes return to [Plan Phase 2](./plan.md#phase-2--plan-review) with a remaining plan round, then resume from its updated handoff. After exhaustion, only deterministic in-scope corrections verified authoritatively and covered by later tests/PR review may continue. Fresh broad review or missing product decisions take one `default` checkpoint or `auto` blocked handoff; no automatic reset.

## Phase 2 — Publish the remote draft PR

Commit/push, then open a **draft** PR using the repository template. Include issue, implementation/justified deviations, acceptance-to-code/test mapping, local/CI-only/manual validation, risks, and deferred work. Read back body/metadata, record pushed SHA, and verify remote diff scope. Relay reviews that remote PR and exact head, never an unpushed substitute.

## Phase 3 — Integrated CI, GitHub, and relay convergence

At most three integrated rounds, each binding one substantive Relay review to one pushed head and collecting required CI plus all visible GitHub review summaries, conversation/inline comments, and threads. After pre-review proof, default to parallel CI, feedback observation, and Relay on every head; pending CI alone is no wait condition.

Combine available findings into one ledger before correction; sources have no separate budgets. Apply shared [problem-level remediation](./review-convergence.md#problem-level-remediation) to the combined verified problem class. Submission timing, early correction, completion barriers, and final readiness are distinct gates below.

### Initial PR review

Prepend the shared [prompt base](./review-convergence.md#review-prompt-assembly) as actual text to initial/final full-review prompts.

```text
Act as a strict code reviewer of this PR against its frozen issue. Return all
currently identifiable blockers in acceptance, plan deviations, tests,
correctness, compatibility, security, performance, and maintainability. Give
severity, exact path/input-state sequence or failing check, expected versus
actual failure, and affected criterion/contract for each stable finding ID.
Return READY_FOR_HUMAN_REVIEW when reviewed code/evidence has no blocker; list risks.

Pending checks are unverified. Name necessary missing proof preventing a
conclusion; ordinary pending CI is not proof of code failure. Final workflow
CI, execution-proof, and feedback gates still apply.

PR: <url>
Issue: <url>
Current pushed head: <sha>
Validation: <passed/pending checks and execution proof, references, scheduling decision>
Project constraint profile: <evidence and unknowns>
```

The unified ledger adds source, severity/contract impact, observed/reviewed/fix heads, disposition, and evidence to shared fields. A `critical-late-finding` from any source requires exact path, triggering input/state/call sequence, expected/actual failure, acceptance/contract impact, and why this PR must fix it.

Verify facts/applicability and reconcile conflicting/duplicate reports. With no blocker, wait for completion/readiness gates. Before round three, blockers may use early correction below. The second full submission includes PR, previous/current heads, complete ledger, fix summary, head-to-head diff, validation evidence, and scheduling decision.

### Review submission and CI scheduling

This policy covers every PR submission, including corrected heads, final convergence, targeted closure, and authorized re-entry. Choose from current evidence without routine permission or Relay scheduling approval.

Before submission:

1. Classify complete visible feedback, correct combined admitted defects, and verify their problem class. Ledger entries may await Relay confirmation.
2. Pass mandated pre-review checks, relevant build/fast/focused tests, and locally required execution proof. Execute target-dependent changed/failed paths on Linux or other required platform; build alone is insufficient. Assess outstanding CI-only proof below.
3. Commit/push, read back PR, pin exact head/CI source identity, and keep the head stable while Relay is queued, in progress, or recovering.
4. Re-read CI/feedback immediately before submission; satisfy the selected waiting condition and disclose passed/pending validation, proof, and references.

| Scheduling choice | Submission condition |
|---|---|
| Parallel (default) | Pre-review proof passed; no unresolved known required-check failure/admitted defect; no concrete important proof gap likely to require a new head. Submit while full CI/feedback observation continue. |
| Wait for named checks | Local proof cannot cover an important changed/previously failing path; identified current-head CI jobs/execution proof can. Wait for those to succeed, then overlap other CI. |
| Wait for full CI | Necessary aggregate proof cannot be narrowed, e.g. job dependencies, artifact transfer, aggregate verdict. Wait for all required CI green. |
| Hold submission | Observed required-check failure, uncorrected defect, missing mandatory pre-review proof, or evidence uncertainty prevents a stable candidate. Diagnose/correct/recover, validate, and reassess. |

Record head, round/remaining budget, scheduling choice/basis, and pending proof. A wait names risk, missing proof, jobs/runs where available, and release result. Duration, complexity, security/concurrency labels, or hypothetical failure are insufficient. Previous failure requires correction proof, not permanently serial later reviews.

With fewer rounds, scrutinize proof likely to force another head; third review/targeted closure can still run parallel with adequate evidence, never on an identified unstable candidate. Known pre-submission failures are combined/fixed before spending review. External/pre-existing/infrastructure failure is not a pass: recover under repository policy or preserve budget and block if required submission evidence is unavailable. CI failure after submission neither cancels/duplicates the Relay task nor refunds its round; retain result and hold new submissions until addressed.

### Round evidence and progression

For each exact head:

- Track required CI, separating PR-caused from external/pre-existing failures. Pending/cancelled/skipped/absent proof is not success; CI-only coverage remains unverified until passed remotely.
- Paginate conversation comments, submitted reviews, inline comments, and GraphQL `PullRequestReviewThread` nodes using `isResolved`; REST comments and unresolved threads alone are incomplete feedback.
- Fix actionable findings or answer rejection/defer/duplicate/stale dispositions concretely. Reply and resolution differ; resolve only when policy permits and actually handled.
- Record expected reviews, completion cutoff, and latest comment/thread identifiers. The gate is no **unaddressed actionable feedback**, not zero unresolved threads; report answered reviewer-owned unresolved threads.

Pre-cutoff findings join the ledger under source heads and require current applicability verification. A blocker first visible after the third completion barrier blocks unless targeted closure already covers that exact finding; it grants no fourth full round.

**Early correction:** before round three, after Relay's effective substantive result and a verified blocker needing a new head, read complete visible feedback and begin combined correction without waiting for obsolete CI/automation. Investigation/preparation may overlap active Relay, but never push a different head or cancel to advance. Delivery failures/ambiguity follow agent-guide recovery, not this shortcut.

Before pushing, refresh CI/feedback and incorporate further applicable findings. Mark the old head superseded/incomplete with task IDs/results, cutoff, and pending checks/reviews; its substantive review consumes a round. Read available late results before next submission/final cutoff, carry unresolved problems/risks into scheduling, and obtain new-head proof. Do not wait merely for obsolete runs or monitor indefinitely; old missing/cancelled proof establishes no current correctness.

**Round completion barrier:** for the retained candidate, required checks must be terminal; required/requested automated reviews terminal or documented infrastructure failures; optional reviews at a recorded bounded cutoff; GitHub feedback paginated through it; Relay returned or failed under agent-guide rules. Human review has no terminal state. Classify all evidence before final readiness or targeted closure. Documented failure is not a validation pass.

No Relay blocker with pending CI means retain head and wait. Later CI success on that unchanged head needs no resubmission. Failure requiring a new head uses remaining budget/scheduling; after exhaustion only the named targeted exception or user-authorized new budget permits review.

### Third full review — final PR convergence

Use the third round only on a candidate satisfying submission policy and selected waits. All three channels still complete through the round barrier; Relay alone cannot establish readiness.

```text
This is final PR convergence. Do not restart broad review, reopen resolved
findings without evidence, or add optional scope. Review unresolved findings,
blocker regressions, new CI/test/code evidence, proven critical late findings,
and acceptance/repository-contract violations on this head. Give stable IDs,
classifications, exact paths/triggers, expected/actual failure, affected contract,
and why each blocks.

Return exactly one verdict:
- READY_FOR_HUMAN_REVIEW: reviewed code/evidence has no blocker; workflow gates still apply.
- CORRECT_AND_CLOSE: only named deterministic bounded fixes remain; list IDs/corrections.
- BLOCKED_HANDOFF: broader review, user decision, or unresolved work prevents convergence.
Do not request another full review.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>
Validation: <passed/pending proof, references, scheduling decision>
Project constraint profile: <evidence and unknowns>
Finding ledger: <complete ledger>
Fix summary and diff: <complete head-to-head changes>
```

Missing required submission evidence from infrastructure failure preserves the round and yields blocked handoff; healthy pending CI outside selected waits permits parallel review. After the third barrier, any admissible blocker from any source blocks except the precise targeted-closure case below.

### Targeted closure

Only third-round `CORRECT_AND_CLOSE`, after its completion barrier, permits **one** targeted check when every remaining unified-ledger blocker belongs to the same named deterministic correction set. Apply only those minimum corrections, verify their problem class, push, and apply submission policy with an explicit scheduling decision. Complete required CI, feedback sweep, and targeted Relay on that closure head. Unrelated substantive changes invalidate this exception; new broad review needs user-authorized budget.

```text
This is targeted closure, not full review. Check only resolution of the named
IDs and proven blocker regressions directly caused by their fix diff. Do not
reopen broad review or add unrelated/style/refactoring findings. A new blocker
requires exact path, trigger, expected/actual failure, and acceptance/contract impact.

Return exactly one verdict:
- CLOSED: named blockers resolved with no blocker regression.
- BLOCKED_HANDOFF: a named blocker remains or its fix causes a proven blocker.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>
Named finding IDs: <ids>
Validation: <passed/pending proof, references, scheduling decision>
Targeted fix diff: <complete diff>
```

Normalize `CLOSED` to readiness only for this exact head with required CI green and no unaddressed actionable GitHub finding. Remaining, fix-caused, or newly reported blockers yield `BLOCKED_HANDOFF`; no automatic second fix/push. Non-blocking suggestions become risk/follow-up. After exhaustion, severe in-scope defects may be fixed/tested only when safety requires immediate correction; their new head lacks a clean verdict and stays blocked without new authorized budget.

Record shared agent-owned continuation; never ask Relay whether `auto` may proceed. Shared deterministic-correction permission cannot waive this PR stage's clean-verdict/targeted-closure restrictions.

### Final readiness gate

1. Re-read required checks and paginate threads.
2. Update summary, acceptance mapping, validation, deviations, and risks for all fixes.
3. Read back remote body/metadata/diff against current head.
4. Record exact head and latest comment/review/thread/check IDs as pre-handoff cutoff.

Require all required CI green on the current exact head, clean Relay verdict, required E2E/manual proof, no verified blocker, every actionable thread fixed/deliberately answered, complete acceptance coverage, and matching PR body. Parallel verdicts/old-head CI do not substitute.

If still draft, promote to ready only after this gate; if already ready, preserve state. Immediately read back: report `READY_FOR_HUMAN_REVIEW` only with non-draft PR, unchanged approved head, and correct body/metadata. Do not wait for or consume feedback/checks/reviews first triggered by promotion or first visible after cutoff; those use user-owned re-entry below.

Gate, promotion, or readback failure/head drift yields `BLOCKED_HANDOFF`, unmerged. Failed candidates are not promoted; already-ready state changes require explicit user instruction. Exhaustion grants no approval, merge, or closure authority.

## Phase 4 — Handoff

Report mode/outcome; PR URL/current and reviewed heads/confirmed state; implementation and acceptance mapping; local/CI/feedback status; deviations; Relay verdict/round count, scheduling/wait evidence, superseded heads/cutoffs, targeted result; continuation, risks/deferred work/blockers, and answered unresolved reviewer-owned threads.

The workflow owns initial exact-gate promotion and idempotent confirmation only. Human review, merge, later state changes, and post-cutoff re-entry remain user-owned.

## Post-handoff PR feedback re-entry

`READY_FOR_HUMAN_REVIEW` confirms the exact head/gates at its cutoff, not completion of post-cutoff automation. Do not automatically monitor/handle reviews, checks, or comments first visible afterward or triggered by promotion. Re-enter only for a user-requested batch.

Ready state stays sticky: never return to draft or repeat promotion without explicit state-change instruction. Express renewed readiness through evidence/verdict/cutoff/handoff.

On requested re-entry, preserve mode/session, read all feedback since cutoff, update existing ledger, and classify the complete visible batch before editing:

- **New committed head required:** preserve ready state and re-enter Phase 3 for a fresh integrated cycle of at most three rounds. This is the workflow-defined new-cycle condition: retain prior ledger, approved head, dispositions, and reopening reason; never reset within the cycle. Handle the whole batch, answer dispositions, validate/push, reassess scheduling, complete required CI/feedback, and review the full current PR/exact head, not merely the fix diff. Final gate confirms existing ready state.
- **No new head:** answer appropriate rejected/deferred/duplicate/stale feedback, rescan, report dispositions, and retain the exact-head verdict unless the user explicitly requests another Relay cycle.

Pre-round-cutoff arrivals join the active cycle; later completed-handoff batches require another user resume. Never monitor indefinitely or silently extend a finished cycle.
