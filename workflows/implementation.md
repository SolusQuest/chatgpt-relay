# Workflow: Implementation

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes and session selection: [execution modes](./README.md#execution-modes) and [session selection](./README.md#relay-session-selection)
- Stage handoffs and reference loading: [stage handoffs and delegation](./README.md#stage-handoffs-and-delegation)
- Review protocol: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`plan.md`](./plan.md): when a handoff mismatch or material plan deviation requires returning to Plan. Consuming a complete, applicable reviewed plan uses the shared handoff rules without rereading Plan's procedure.
- [`issue-to-pr.md`](./issue-to-pr.md) or [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): when coordinating the selected full composition. A delegated Implementation agent inherits its invocation context and authority through the handoff.

## Purpose and routing

Use this stage to consume a reviewed implementation/test plan and complete code, tests, validation, a remote draft PR, integrated CI/GitHub/relay convergence, the initial exact-gate ready-for-review promotion, and user handoff. It owns the existing implementation and PR gates. Both standalone and composed execution end at `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.

When no usable reviewed plan exists, use [`plan.md`](./plan.md) or the appropriate full composition. Do not infer a completed plan review from a prose summary or start coding while its readiness is unknown. Do not use this stage for exploratory work, trivial edits whose review overhead exceeds risk, or when the user explicitly declines relay.

## Preconditions and handoff validation

- The authoritative frozen issue, complete reviewed plan, and [stage handoff](./README.md#stage-handoffs-and-delegation) are accessible, including artifact revisions, repository baseline, applicable review evidence and continuation decision, ledger, remaining budgets, and fallback record.
- Repository instructions, design contracts, and declared dependencies are accessible.
- The user authorized implementation, branch publication, a draft PR, relay review, and the final gate's initial draft-to-ready transition. A `PLAN_READY` record does not grant these permissions.
- Resolve or inherit the task-specific session using the shared [session-selection rule](./README.md#relay-session-selection), and require it to be usable before each submission.
- Record or inherit the execution mode; preserve the same task identity, session, ledger, and budgets through implementation and PR review.

Before editing, verify the issue and plan revisions, review disposition, current repository baseline and relevant working-tree state, instructions, and dependencies against the handoff. Reuse applicable prior investigation and review; an agent change or elapsed time alone does not trigger another plan cycle. If new evidence changes the plan's applicability, record the concrete difference and return to [Plan](./plan.md) for affected readiness or plan decisions under the existing budget and authority rules. This handoff validation is not an additional routine Relay review or user approval gate.

The [automatic readiness fallback](./plan.md#automatic-readiness-fallback) remains owned by Plan and is available only before implementation has started and only when all its original conditions hold. Implementation does not invoke Design directly or regain fallback eligibility after coding begins. Material changes discovered during implementation follow the plan-deviation rule below.

## Phase 1 — Implement and validate

Implement production behavior and tests together within the frozen issue:

- Use focused tests and static checks during iteration.
- Use small semantic commits when repository policy calls for them.
- Before publishing a review candidate, pass repository-mandated local checks and the relevant build, static checks, fast or focused tests, contract/fixture checks, and actual target-platform execution needed to validate the change and previously failing paths. Follow the [review submission policy](#review-submission-and-ci-scheduling).
- Verify every acceptance criterion against code and tests.
- For bugs, demonstrate a failing regression before the fix when practical; for new behavior, directly cover acceptance and failure paths.

Do not create artificial naive/no-op evidence that proves nothing. Update the visible plan when implementation-local details improve without changing scope.

Record broader validation delegated to full CI and any outstanding required end-to-end or manual execution proof. Complete every relevant validation requirement before final readiness; early review does not waive repository-mandated checks or acceptance evidence.

Do not add compatibility, versioning, migration, abstraction, or operational machinery solely because relay recommended it. Implement only admitted requirements and the minimum sufficient corrections recorded in the ledger.

If implementation reveals a material architecture, public-contract, migration, security, or test-strategy change, return to [`plan.md` Phase 2](./plan.md#phase-2--plan-review) using a remaining plan-review round only when available; preserve the execution chain and resume this stage after the updated plan handoff. After budget exhaustion, continue only for a deterministic in-scope correction verified from authoritative evidence and covered later by tests and PR review. A fresh broad review or missing product decision requires one checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`; never reset automatically.

## Phase 2 — Publish the remote draft PR

Commit and push the implementation branch, then open a **draft** PR using the repository template as a contract. Its body must reference the issue, summarize implementation and justified plan deviations, map every acceptance criterion to code/tests, list local and CI-only/manual validation, and record risks and deferred follow-ups.

Read the remote PR back, verify rendered body and metadata, record the pushed head SHA, and confirm the remote diff matches intended local scope. Relay reviews that remote PR and exact head, never an unpushed local substitute.

## Phase 3 — Integrated CI, GitHub, and relay convergence

Use at most three integrated PR convergence rounds. Each round binds one substantive relay review to one exact pushed head and gathers evidence from the same three channels:

1. Required CI.
2. All visible GitHub review feedback, including review summaries, conversation comments, inline comments, and review threads.
3. One substantive relay review submission.

After the required pre-review validation, default to CI, GitHub feedback observation, and relay review in parallel on every candidate head in both execution modes, subject to the [review submission and CI scheduling policy](#review-submission-and-ci-scheduling). Ordinary pending CI does not require waiting by itself. A corrected head is reassessed on its evidence rather than permanently making the PR serial.

Aggregate all currently available findings from the three channels into one ledger before fixing the next head. The [round evidence and progression rules](#round-evidence-and-progression) distinguish early correction of a candidate from completion of a round and final readiness. Do not create separate CI, GitHub, and relay review budgets or ignore already available findings from another channel.

Before editing the next head, group findings by underlying cause and apply the [problem-level remediation protocol](./review-convergence.md#problem-level-remediation). Decide the correction against the complete evidenced in-scope failure surface, not only the literal commented line.

### Initial PR review

```text
Act as a strict code reviewer for this PR and its frozen agent-ready
issue.

Return the complete set of currently identifiable blockers. Check acceptance
coverage, plan deviations, tests, and correctness, compatibility, security,
performance, and maintainability. Give every blocker a stable ID, severity,
exact file/code path/input-state sequence or failing check, expected versus
actual failure, affected criterion or contract, why this PR must fix it, and the
minimum correction.

Evaluate applicability before severity. A general best practice is a blocker
only when required by the frozen issue or repository policy, or omission causes
a concrete current failure for a real consumer, persisted artifact, security
boundary, or release commitment. State that basis, affected exposure, failure,
why this PR must fix it now, and why a simpler reversible measure is
insufficient.

Also identify implementation that adds release-grade versioning, migration,
compatibility, deprecation, abstraction, or operations without current evidence;
recommend the minimum sufficient simplification. Project maturity is evidence,
not a blanket exemption.

Separate blockers from optional hardening, style, refactoring, and follow-up work. Return READY_FOR_HUMAN_REVIEW when no blocker remains in the reviewed code and available evidence, and list risks.
Pending checks are unverified. Identify any specific necessary missing proof that prevents a review conclusion; ordinary pending CI alone is not proof of a code failure. The workflow owns final readiness after its required CI, execution proof, and feedback gates complete.

PR: <url>
Issue: <url>
Current pushed head: <sha>

--- validation evidence ---
<passed checks and execution proof, pending checks, evidence references, and scheduling decision>

--- project constraint profile ---
<evidence and unknowns>
```

Apply the shared three-round protocol to the relay submission in each integrated round. The unified PR ledger records source, classification/severity, contract impact, status, observed/reviewed/fix heads, disposition, and evidence. A PR `critical-late-finding` from any channel may block only with exact code location/path, triggering input/state/call sequence, expected versus actual failure, acceptance or contract impact, and why this PR must fix it.

As results arrive, verify disputed repository facts locally, apply the shared applicability test independently, and reconcile duplicate or conflicting reports by evidence. If no admissible blocker remains, wait for the round completion barrier and final readiness gate. If blockers remain before the third round, the early-correction rule below permits fixing the combined verified set, validating, committing, and pushing the next head without waiting for obsolete CI to finish. Record non-blocking work or scope expansion without adopting it mechanically. A review verdict applies only to its exact pushed head.

The second full review includes the PR URL, previous and current heads, complete ledger, fix summary, head-to-head diff, and current validation evidence and scheduling decision. It verifies prior findings, revision regressions, and new evidence without renaming or reopening findings silently.

### Review submission and CI scheduling

This policy owns submission timing for the initial head, corrected heads, third-round convergence, targeted closure, and workflow-defined post-handoff re-entry. The agent chooses the timing from current evidence without a routine permission checkpoint or a separate relay request for scheduling approval.

Before submitting any PR head:

1. Classify the complete currently visible feedback batch and apply problem-level remediation to the combined verified finding set. Correct known admitted defects and verify their affected in-scope problem class; the ledger may still await relay confirmation of those corrections.
2. Pass repository-mandated pre-review checks, the relevant build and fast or focused tests, and locally required execution proof for the changed and previously failing paths. When the change depends on Linux or another target platform, execute the affected path there; a build alone is not execution proof. Assess any CI-only proof still outstanding through the scheduling choices below.
3. Commit and push the candidate, read the remote PR back, and pin the exact head and relevant CI source identity. Keep that remote head stable while its relay task is queued, in progress, or recovering.
4. Re-read current CI and available feedback immediately before submission, choose the scheduling mode below, and satisfy any selected waiting condition. Disclose passed validation, outstanding checks or execution proof, and evidence references in the relay prompt.

| Scheduling choice | Evidence and submission condition |
|---|---|
| Parallel (default) | Pre-review validation passed, no unresolved known required-check failure or admitted defect remains, and no concrete evidence identifies important missing proof likely to require another head change. Submit relay while full required CI and GitHub observation continue. |
| Wait for named checks | A changed or previously failing path has an important verification gap that local evidence cannot cover, and specific current-head CI jobs or execution proofs can close it. Wait for those proofs to succeed, then submit while other CI continues. |
| Wait for full CI | Necessary proof depends on the combined CI result and cannot be established by a narrower check set, for example a changed job-dependency, artifact-transfer, or aggregate-verdict contract. Wait for all required CI to succeed. |
| Hold submission | A required check has an unresolved observed failure, an admitted defect is uncorrected, mandatory pre-review proof is missing, or uncertainty prevents a stable review candidate. Diagnose, correct or recover, validate, and reassess before submitting. |

For each head, record its round and remaining budget, scheduling choice, evidence basis, and pending verification. A waiting decision must identify the concrete risk, missing proof, named jobs or runs where available, and the result that releases the wait. CI duration, general complexity, a concurrency/security label, or the possibility that some test might fail is insufficient by itself. Previous failure strengthens the need for correction evidence; it does not force all later heads to wait for full CI once that evidence exists.

As budget decreases, assess more carefully whether outstanding proof could force another head change. Third-round review and the single targeted closure check still permit parallel scheduling when supported by evidence; neither is automatically serial, and neither permits spending a last submission on an identified unstable candidate.

If CI or feedback observed before submission proves another correction is needed, combine the known problems and prepare a new candidate before consuming the review. An external, pre-existing, or infrastructure failure is not a pass: recover the failing check under repository policy, or preserve the remaining review budget and use `BLOCKED_HANDOFF` when required submission evidence cannot be obtained. Do not cancel or duplicate an already submitted relay task because CI subsequently fails; retain its result and round accounting, and hold new submissions until the known failure is addressed.

### Round evidence and progression

For every round:

- Track required CI by exact head and distinguish PR-caused failures from external or pre-existing failures. Pending, cancelled, skipped, or absent required proof is not successful validation.
- Treat CI-only coverage as unverified until its remote check succeeds.
- Read all paginated PR conversation comments, submitted reviews, and inline review comments; do not assume unresolved threads are the complete feedback set.
- Query all paginated `PullRequestReviewThread` nodes through GitHub GraphQL and use `isResolved`; REST comments do not expose thread resolution.
- For each feedback item, fix actionable findings or reply with the concrete reason for rejecting, deferring, or treating it as duplicate/stale. Reply and resolution are separate actions; resolve only when policy permits and the finding is actually handled.
- Record the round head, expected-review status, feedback cutoff, and latest observed comment/thread identifiers so later arrivals are distinguishable.

The gate is no **unaddressed actionable feedback**, not mechanically zero unresolved threads. Answered reviewer-owned unresolved threads appear in handoff. Findings arriving before a recorded completion cutoff enter the active ledger under their original source heads; verify their applicability to the current head before disposition. A blocker first visible after the third completion barrier leaves the PR blocked unless targeted closure already covers that exact finding; it never opens an unrestricted fourth round.

**Early correction:** before the third round, once relay has returned its effective substantive review and an agent-verified blocker requires a new head, read the complete currently visible feedback batch and begin the combined correction without waiting for the old head's full CI or automated reviews to finish. Local investigation and preparation may happen while relay is active, but do not push a different PR head or cancel the review merely to advance. Relay execution failures or ambiguous delivery follow `agent-instructions.md` recovery rules, not this early-correction shortcut.

Before publishing the next head, refresh available CI and GitHub feedback and include any further applicable findings in the correction. Mark the old round head superseded with its task IDs, results, feedback cutoff, and outstanding checks or reviews. Its substantive review still consumes a round. Read available late results before the next submission and final completion cutoff, carry unresolved problems or risks into the next head's scheduling decision, and obtain required proof on that new head. Do not wait solely for obsolete runs to finish or monitor them indefinitely; missing or cancelled old-head proof never establishes current-head correctness.

**Round completion barrier:** for a head that remains the candidate, wait until required checks are terminal, required or explicitly requested automated reviews are terminal or have a documented infrastructure failure, optional reviews have reached a recorded bounded cutoff, GitHub feedback is paginated through that cutoff, and relay has returned or failed under `agent-instructions.md`. Human review has no terminal state; the cutoff defines what the round observed. Classify the complete evidence set before final readiness or use of third-round targeted closure. A superseded early-correction head is recorded as incomplete, not a completed clean candidate.

If relay finds no blocker while CI is pending, keep the same head and wait for required verification. A later CI pass on that unchanged head does not require another relay submission. A later failure that requires a new head uses the remaining review budget and the scheduling policy; after budget exhaustion, only the named targeted-closure exception or new user-authorized budget permits further review.

### Third full review — final PR convergence

Spend the third round only after the candidate head satisfies the review submission policy, including any evidence-based waiting decision. Evaluate required CI, GitHub feedback, and relay against that head through the round completion barrier; do not declare readiness from relay alone.

```text
This is the final convergence review for the PR. Do not restart broad
review, reopen resolved findings without evidence, or add optional scope.

Review only unresolved ledger findings, blocker-level regressions from the
latest fixes, new CI/test/code evidence, proven critical late findings, and
acceptance or repository-contract violations on the current head.

For each blocker, give its ID and classification, exact path and trigger,
expected versus actual failure, affected criterion or contract, why it blocks,
current applicability evidence, and the minimum sufficient correction. A generic
best practice without a real current exposure and failure is non-blocking.

Return exactly one verdict:
- READY_FOR_HUMAN_REVIEW: no blocker remains in the reviewed code and available evidence on this head; final workflow gates still apply.
- CORRECT_AND_CLOSE: only named blockers with deterministic bounded fixes
  remain; list IDs and minimum corrections.
- BLOCKED_HANDOFF: safe convergence requires broader review, a user decision, or
  unresolved work.

Do not request another full review.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>

--- validation evidence ---
<passed checks and execution proof, pending checks, evidence references, and scheduling decision>

--- project constraint profile ---
<evidence and unknowns>

--- finding ledger ---
<complete ledger>

--- fix summary and diff ---
<summary and diff>
```

If external CI or review infrastructure prevents obtaining evidence required by the submission policy, preserve the remaining round and return `BLOCKED_HANDOFF` instead of spending it ceremonially. Healthy pending CI outside the selected waiting condition does not by itself prevent parallel review.

After the third round completion barrier, any admissible blocker from CI, GitHub feedback, relay, or agent verification yields `BLOCKED_HANDOFF`, except for the exact targeted-closure case below. Exhausted rounds never authorize another general fix-and-review cycle.

### Targeted closure

Only third-round `CORRECT_AND_CLOSE`, after the third round completion barrier, permits one targeted closure check, and only when every remaining blocker in the unified ledger is part of the same named deterministic correction set. It is not a fourth full review. Apply only the named minimum corrections, validate their affected problem class, push, and satisfy the review submission policy with an explicit scheduling decision for this final check. Complete required CI, the GitHub feedback sweep, and the relay targeted check on that exact closure head before readiness. An unrelated substantive change invalidates targeted closure as a broad-review substitute and leaves the PR blocked unless the user authorizes new budget.

```text
This is a targeted closure check, not a full PR review.

Check only whether the named IDs are resolved on the current head and whether
their fix diff directly introduces a proven blocker-level regression. Do not
reopen broad review or add unrelated, style, or refactoring findings.

A new blocker requires exact path, trigger, expected versus actual failure, and
acceptance or contract impact.

Return exactly one verdict:
- CLOSED: named blockers are resolved with no blocker regression.
- BLOCKED_HANDOFF: a named blocker remains or its fix causes a proven blocker.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>
Named finding IDs: <ids>

--- validation evidence ---
<passed checks and execution proof, pending checks, evidence references, and scheduling decision>

--- targeted fix diff ---
<diff>
```

Normalize `CLOSED` to `READY_FOR_HUMAN_REVIEW` for that exact head only when required CI is green and the closure-head GitHub feedback sweep has no unaddressed actionable finding. A remaining, fix-caused, or newly reported blocker yields `BLOCKED_HANDOFF`; do not repair and push again automatically. Non-blocking suggestions become risk/follow-up. If a severe in-scope defect appears after budget exhaustion, fix and test it only when safety requires immediate correction, but the new head lacks a clean verdict and remains blocked unless the user authorizes new review budget.

Do not ask relay whether `auto` may continue. Apply and record the shared agent-owned continuation decision. In `auto`, accepted blockers are fixed without routine checkpoints; unsupported preferences do not block; authority blockers, absolute disagreements, or inability to obtain a required clean exact-head verdict produce one consolidated `BLOCKED_HANDOFF`.

### Final readiness gate

Before classification:

1. Re-read required checks and paginate review threads again.
2. Update PR summary, acceptance mapping, validation evidence, plan deviations, and risks after all fixes.
3. Read the remote PR back and verify rendered body, metadata, and diff against the current head.
4. Record the exact head and latest observed comment, review, thread, and check identifiers as the pre-handoff feedback cutoff.

An exact-head handoff candidate requires the complete set of required CI checks to finish green on the current exact head with a clean relay verdict, all required end-to-end or manual execution proof, no agent-verified blocker, every actionable thread fixed or deliberately answered, complete acceptance coverage, and a remote PR body that describes that head. Neither a parallel review verdict nor an old-head CI pass substitutes for this gate.

When those requirements pass, convert the PR to ready for review only if it is still draft. If it is already ready, do not toggle its state. In either case, immediately read the remote PR back. Return and report `READY_FOR_HUMAN_REVIEW` only when the remote PR is not draft, its head still equals the exact approved head, and its body and metadata remain correct. Do not wait for or consume checks, reviews, or comments first triggered by the initial ready-for-review transition; anything first visible after the recorded cutoff is post-handoff feedback owned by the user-decision rule below.

If the readiness requirements, required initial state transition, or readback fail, or if the head changes during promotion or confirmation, return `BLOCKED_HANDOFF` with exact evidence and keep the PR unmerged. Do not promote a draft PR that failed the gate. Preserve an already-ready PR's state unless the user explicitly requests a change, and never treat exhausted rounds as approval, merge, or issue-closure authorization.

## Phase 4 — Handoff

Report:

1. Execution mode and `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.
2. PR URL, current head, relay-reviewed head if different, and confirmed remote draft/ready state.
3. Implementation summary and acceptance-to-code/test mapping.
4. Local validation, CI, and actionable-feedback status.
5. Material plan deviations.
6. Relay verdict, integrated PR-round count, scheduling decisions and waiting evidence, superseded-head records where applicable, feedback cutoffs, and targeted closure result.
7. Agent continuation decision, risks, deferred work, blockers, and answered-but-unresolved reviewer-owned threads.

The workflow owns only the initial exact-gate draft-to-ready transition and later idempotent ready-state confirmation. The user owns final human review, merge, any later ready/draft state change, and whether the agent re-enters for feedback first visible after the recorded handoff cutoff.

## Post-handoff PR feedback re-entry

After a `READY_FOR_HUMAN_REVIEW` handoff, the PR is remotely confirmed ready for review. Checks, automated reviews, human reviews, and comments triggered by the ready-for-review transition or first visible after the recorded cutoff are post-handoff feedback. Do not monitor or handle them automatically. The user decides whether the agent re-enters this workflow for that feedback batch.

The ready state means that the agent workflow passed on the exact head at the recorded cutoff and human review may begin. It does not claim that post-cutoff automation has completed or approved the PR.

After the initial promotion, ready-for-review is sticky across agent re-entry. Do not return the PR to draft or repeat the ready transition unless the user explicitly requests that state change. Express renewed exact-head readiness through CI, relay verdicts, feedback cutoffs, and the next handoff rather than another ready-for-review event.

When the user requests re-entry, preserve the PR's execution mode and task-specific relay session, read every feedback item added since the last recorded cutoff, update the existing ledger, and classify the complete visible batch before editing the PR.

Any post-handoff feedback batch that requires a committed artifact change and therefore a new PR head keeps the PR ready for review while it re-enters Phase 3 and completes a fresh integrated convergence cycle of at most three rounds: handle the complete visible batch, fix actionable findings, answer rejected/deferred/duplicate/stale feedback, validate changes, push, apply the same evidence-based review submission and CI scheduling policy, and complete required CI and the feedback sweep before another exact-head `READY_FOR_HUMAN_REVIEW` handoff. This is an explicit workflow-defined new-cycle condition under `review-convergence.md`: carry forward the prior ledger, previous relay-approved head, feedback dispositions, and reason for reopening; do not reset the ledger or the budget within the new cycle. Reassess each new head rather than automatically serializing review after a head change. Relay reviews the full current PR and exact pushed head, not only the comment-fix diff, and the final gate confirms the existing ready state without toggling it.

If the batch does not require a new PR head, keep the PR ready for review, answer rejected/deferred/duplicate/stale feedback as appropriate, and retain the previous exact-head relay verdict; rescan GitHub feedback and report the dispositions unless the user explicitly requests a new relay cycle. Feedback visible before a round cutoff joins the active cycle. Feedback arriving after the completed handoff starts a later batch only when the user resumes the workflow; do not monitor indefinitely or silently extend a finished cycle.
