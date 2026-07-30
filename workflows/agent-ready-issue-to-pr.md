# Workflow: Agent-ready issue → reviewed plan → implementation → draft PR

**Required references**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes: [`workflows/README.md`](./README.md#execution-modes)
- Review protocol: [`review-convergence.md`](./review-convergence.md)
- Rough-issue refinement: [`issue-to-pr.md`](./issue-to-pr.md)

---

## Purpose and routing

Use this workflow when the issue is a frozen implementation contract with settled product decisions, explicit scope and non-goals, testable acceptance criteria, and declared dependency handling. It maps that contract onto the current repository, reviews the implementation/test plan, then continues through code, tests, validation, a remote draft PR, CI, relay code review, GitHub review threads, and user handoff.

Use `issue-to-pr.md` when material product, scope, or acceptance questions remain. Do not use this workflow for exploratory work, trivial edits whose review overhead exceeds risk, or when the user explicitly declines relay.

`default` preserves explicit checkpoints; `auto` continues without routine intervention to `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`. Both modes use identical quality gates.

## Preconditions

- The authoritative issue is available by URL or complete text.
- Repository instructions, design contracts, and declared dependencies are accessible.
- Relay is reachable and the user supplied a non-paused, task-specific session.
- The user authorized implementation, branch publication, a draft PR, and relay review.
- Record or inherit the execution mode; pin the same mode and session through plan and PR review.

## Phase 1 — Readiness and implementation/test plan

Read the complete issue, repository instructions, relevant contracts, current implementation, and nearby tests. Confirm explicit scope/non-goals, testable acceptance criteria, no unresolved product or public-contract decision, and usable dependency handling. This is classification, not refinement.

Verify or derive the issue's concise project constraint profile from current evidence, recording only dimensions that can change the implementation decision: release state and milestone purpose; real or committed near-term consumers and deployments; persisted production data or long-lived artifacts; compatibility/versioning commitments; reversibility and failure cost; and security, privacy, or regulatory boundaries. Use it throughout plan and PR review. Do not infer release-grade requirements from a maturity label or generic best practice.

If an explicit frozen requirement appears materially disproportionate and cannot reasonably be satisfied by a narrower interpretation, record one contract-applicability challenge with evidence. Do not silently ignore it or spend implementation effort before resolving the contract: use one consolidated checkpoint in `default`, or return `BLOCKED_HANDOFF` in `auto`. A relay preference that is not part of the frozen contract does not trigger this checkpoint.

If readiness fails, return the complete missing-decision set and recommend `issue-to-pr.md`. Use one checkpoint in `default`; in `auto`, do not rewrite the frozen issue and return `BLOCKED_HANDOFF` after independent safe analysis.

### Plan creation

Use the **standard path** when the change follows established repository patterns and has a largely obvious, low-risk implementation route. The agent inspects the repository and writes the plan before Phase 2 review.

Use **parallel independent discovery** when the change affects a public API/schema/persisted format/migration/compatibility boundary; security, privacy, concurrency, recovery, or state consistency; multiple repositories or owners; materially different viable approaches; or another high-rework-risk path.

For parallel discovery, use the barriers from `agent-instructions.md`: submit a context-only relay task before writing agent opinions, persist the complete agent plan before reading relay, then verify and synthesize relay-only blind spots into one agent-owned plan. A genuine product decision uses one checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`.

The resulting visible plan contains:

1. Affected components and expected files.
2. Implementation order and key engineering choices.
3. Every acceptance criterion mapped to production behavior and tests.
4. Happy, boundary, failure, regression, concurrency, and state-transition coverage as applicable.
5. The applicable compatibility, migration, security, privacy, performance, and operational measures, with evidence and the minimum sufficient approach.
6. Focused and complete validation, including CI-only or manual checks.
7. Known risks and assumptions.

Keep it proportional: enough to expose a wrong path, not a second issue body.

## Phase 2 — Plan review

Plan review is mandatory for non-trivial work in both creation paths and is not a routine user approval gate.

### Initial review

```text
Act as a strict implementation and test-plan reviewer for this agent-ready
issue. Product scope and acceptance criteria are frozen.

Return the complete set of currently identifiable blockers. Check acceptance
coverage, repository boundaries and contracts, compatibility or migration,
failure paths, security, performance, operational behavior, tests, validation,
and ordering. For each blocker, cite the exact criterion or source, explain the
implementation failure, and give the minimum correction.

Evaluate applicability before severity. A general best practice is a blocker
only when required by the frozen issue or repository policy, or omission causes
a concrete current failure for a real consumer, persisted artifact, security
boundary, or release commitment. State that basis, affected exposure, failure,
why this plan must address it now, and why a simpler reversible measure is
insufficient.

Also identify planned release-grade versioning, migration, compatibility,
deprecation, or operational complexity that lacks current evidence; recommend
the minimum sufficient alternative. Project maturity is evidence, not a blanket
exemption.

Separate blockers from implementation-local detail, optional hardening, style,
and follow-up work. State explicitly when implementation may begin.

Issue: <url>

--- project constraint profile ---
<evidence and unknowns>

--- implementation/test plan ---
<complete plan>
```

Apply the three-round budget and stable ledger from `review-convergence.md`. A plan `critical-late-finding` must identify the exact criterion, code path, contract, or source; the concrete implementation failure; and why it must be resolved before implementation. Record `late-nonblocking` and `out-of-scope` work without silently changing the issue.

The agent independently applies the shared applicability test to every relay finding. Reject or defer a generally sound recommendation when it lacks current authority, exposure, failure, or scope necessity; use the narrowest adequate measure for an admitted blocker. Repetition without new evidence does not reopen the finding.

The second submission includes the complete current plan, ledger, revision summary, and verified repository evidence.

### Third submission — final plan convergence

```text
This is the final implementation/test-plan convergence review. The issue is
frozen. Do not restart design review, reopen resolved findings without evidence,
or add optional scope.

Review only unresolved ledger findings, revision regressions, new authoritative
evidence, and proven critical late findings. For each blocker, give its ID,
classification, exact source, concrete implementation failure, why it blocks,
current applicability evidence, and the minimum sufficient correction. A generic
best practice without a real current exposure and failure is non-blocking.

Return exactly one verdict:
- READY: no admissible implementation blocker remains.
- CORRECT: only deterministic implementation-local corrections remain.
- ESCALATE: a product decision, material trade-off, or fundamental re-plan is
  required.

Do not request another full review.

Issue: <url>

--- project constraint profile ---
<evidence and unknowns>

--- finding ledger ---
<complete ledger>

--- revision summary ---
<changes since the previous round>

--- implementation/test plan ---
<complete plan>
```

Apply the shared continuation protocol:

- `READY` → implement.
- `CORRECT` → make and verify the minimum correction, update the ledger, implement, and require tests and PR review to cover the corrected area.
- Product/public-contract/compatibility/migration/security/privacy decision or absolute disagreement → one checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.
- Fundamental re-plan or unready issue → one return-to-planning recommendation in `default`; no automatic reset in `auto`.

The budget belongs to the current plan cycle. Only an explicit user-authorized material change to the issue or engineering risk boundary starts another full cycle; carry the ledger and reason forward.

## Phase 3 — Implement and validate

Implement production behavior and tests together within the frozen issue:

- Use focused tests and static checks during iteration.
- Use small semantic commits when repository policy calls for them.
- Before publication, run every relevant test, lint, typecheck, build, format, contract, and fixture check.
- Verify every acceptance criterion against code and tests.
- For bugs, demonstrate a failing regression before the fix when practical; for new behavior, directly cover acceptance and failure paths.

Do not create artificial naive/no-op evidence that proves nothing. Update the visible plan when implementation-local details improve without changing scope.

Do not add compatibility, versioning, migration, abstraction, or operational machinery solely because relay recommended it. Implement only admitted requirements and the minimum sufficient corrections recorded in the ledger.

If implementation reveals a material architecture, public-contract, migration, security, or test-strategy change, use a remaining Phase 2 round only when available. After budget exhaustion, continue only for a deterministic in-scope correction verified from authoritative evidence and covered later by tests and PR review. A fresh broad review or missing product decision requires one checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`; never reset automatically.

## Phase 4 — Publish the remote draft PR

Commit and push the implementation branch, then open a **draft** PR using the repository template as a contract. Its body must reference the issue, summarize implementation and justified plan deviations, map every acceptance criterion to code/tests, list local and CI-only/manual validation, and record risks and deferred follow-ups.

Read the remote PR back, verify rendered body and metadata, record the pushed head SHA, and confirm the remote diff matches intended local scope. Relay reviews that remote PR and exact head, never an unpushed local substitute.

## Phase 5 — Integrated CI, GitHub, and relay convergence

Use at most three integrated PR convergence rounds. Each round evaluates one exact pushed head through the same three channels:

1. Required CI.
2. All visible GitHub review feedback, including review summaries, conversation comments, inline comments, and review threads.
3. One substantive relay review submission.

Complete relevant local validation before pushing the round head. Start CI inspection and relay review while observing expected GitHub review on that same remote head in parallel when practical, then wait at a round barrier before deciding: required checks are terminal, required or explicitly requested automated reviews are terminal or have a documented infrastructure failure, optional reviews have reached a recorded bounded cutoff, GitHub feedback has been paginated through that cutoff, and relay has returned or failed under `agent-instructions.md`. Human review has no terminal state; the cutoff defines what the round observed.

Aggregate all three channels into one ledger before fixing the next head. Do not create separate CI, GitHub, and relay review budgets or serially patch one channel while ignoring already available findings from the others.

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

Separate blockers from optional hardening, style, refactoring, and follow-up
work. Return READY_FOR_HUMAN_REVIEW when no blocker remains and list risks.

PR: <url>
Issue: <url>
Current pushed head: <sha>

--- project constraint profile ---
<evidence and unknowns>
```

Apply the shared three-round protocol to the relay submission in each integrated round. The unified PR ledger records source, classification/severity, contract impact, status, observed/reviewed/fix heads, disposition, and evidence. A PR `critical-late-finding` from any channel may block only with exact code location/path, triggering input/state/call sequence, expected versus actual failure, acceptance or contract impact, and why this PR must fix it.

After the round barrier, verify disputed repository facts locally, apply the shared applicability test independently, and reconcile duplicate or conflicting reports by evidence. If no admissible blocker remains, proceed to the final readiness gate. If blockers remain before the third round, fix the combined verified set with minimum sufficient measures, validate, commit, and push the next head. Record non-blocking work or scope expansion without adopting it mechanically. A readiness verdict applies only to its exact pushed head.

The second full review includes the PR URL, previous and current heads, complete ledger, fix summary, and head-to-head diff. It verifies prior findings, revision regressions, and new evidence without renaming or reopening findings silently.

### Integrated round barrier

For every round:

- Wait for required CI to reach a terminal state and distinguish PR-caused failures from external or pre-existing failures.
- Treat CI-only coverage as unverified until its remote check succeeds.
- Read all paginated PR conversation comments, submitted reviews, and inline review comments; do not assume unresolved threads are the complete feedback set.
- Query all paginated `PullRequestReviewThread` nodes through GitHub GraphQL and use `isResolved`; REST comments do not expose thread resolution.
- For each feedback item, fix actionable findings or reply with the concrete reason for rejecting, deferring, or treating it as duplicate/stale. Reply and resolution are separate actions; resolve only when policy permits and the finding is actually handled.
- Record the round head, expected-review status, feedback cutoff, and latest observed comment/thread identifiers so later arrivals are distinguishable.

The gate is no **unaddressed actionable feedback**, not mechanically zero unresolved threads. Answered reviewer-owned unresolved threads appear in handoff. Feedback that arrives before the next round barrier joins that round. A blocker first visible after the third barrier leaves the PR blocked unless targeted closure already covers that exact finding; it never opens an unrestricted fourth round.

### Third full review — final PR convergence

Spend the third round only on a candidate head that passed complete relevant local validation. Evaluate required CI, GitHub feedback, and relay against that head through the same integrated barrier; do not declare readiness from relay alone.

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
- READY_FOR_HUMAN_REVIEW: no blocker remains on this head.
- CORRECT_AND_CLOSE: only named blockers with deterministic bounded fixes
  remain; list IDs and minimum corrections.
- BLOCKED_HANDOFF: safe convergence requires broader review, a user decision, or
  unresolved work.

Do not request another full review.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>

--- project constraint profile ---
<evidence and unknowns>

--- finding ledger ---
<complete ledger>

--- fix summary and diff ---
<summary and diff>
```

If external CI or review infrastructure prevents an evidence-stable candidate, preserve the remaining round and return `BLOCKED_HANDOFF` instead of spending it ceremonially.

After the third barrier, any admissible blocker from CI, GitHub feedback, relay, or agent verification yields `BLOCKED_HANDOFF`, except for the exact targeted-closure case below. Exhausted rounds never authorize another general fix-and-review cycle.

### Targeted closure

Only third-round `CORRECT_AND_CLOSE` permits one targeted closure check, and only when every remaining blocker in the unified ledger is part of the same named deterministic correction set. It is not a fourth full review. Apply only the named minimum corrections, run affected local validation, push, then evaluate required CI, GitHub feedback, and the relay targeted check on that exact closure head. An unrelated substantive change invalidates targeted closure as a broad-review substitute and leaves the PR blocked unless the user authorizes new budget.

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

`READY_FOR_HUMAN_REVIEW` requires green required checks, no agent-verified blocker on the exact relay-approved head, every actionable thread fixed or deliberately answered, complete acceptance coverage, and a remote PR body that describes that head.

Otherwise return `BLOCKED_HANDOFF` with exact evidence and keep the PR unmerged. Preserve its current draft/ready state unless the user explicitly changes it; never treat exhausted rounds as approval, mark ready, merge, or close the issue autonomously.

## Phase 6 — Handoff

Report:

1. Execution mode and `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.
2. Draft PR URL, current head, and relay-reviewed head if different.
3. Implementation summary and acceptance-to-code/test mapping.
4. Local validation, CI, and actionable-feedback status.
5. Material plan deviations.
6. Relay verdict, integrated PR-round count, feedback cutoffs, and targeted closure result.
7. Agent continuation decision, risks, deferred work, blockers, and answered-but-unresolved reviewer-owned threads.

The user owns final human review, `gh pr ready`, and merge.

## Post-handoff PR feedback re-entry

After a `READY_FOR_HUMAN_REVIEW` handoff, whether the PR remains draft or the user has marked it ready, the user may request follow-up on additional human or automated GitHub feedback for the same PR. Preserve the PR's execution mode, current draft/ready state, and task-specific relay session; read every feedback item added since the last recorded cutoff and update the existing ledger. Handle the complete visible batch: fix actionable findings, answer rejected/deferred/duplicate/stale feedback, validate changes, push when PR content changed, wait for required CI, and paginate feedback again.

Any post-handoff feedback batch that changes the PR head must re-enter Phase 5 and complete a fresh integrated convergence cycle of at most three rounds before another `READY_FOR_HUMAN_REVIEW` handoff. This is an explicit workflow-defined new-cycle condition under `review-convergence.md`: carry forward the prior ledger, previous relay-approved head, feedback dispositions, and reason for reopening; do not reset the ledger or the budget within the new cycle. Relay reviews the full current PR and exact pushed head, not only the comment-fix diff.

If handling the batch does not change PR content or head, the previous exact-head relay verdict remains applicable; rescan GitHub feedback and report the dispositions unless the user explicitly requests a new relay cycle. Feedback visible before a round cutoff joins the active cycle. Feedback arriving after the completed handoff starts a later batch only when the user resumes the workflow; do not monitor indefinitely or silently extend a finished cycle.
