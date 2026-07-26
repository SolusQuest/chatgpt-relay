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
5. Relevant compatibility, migration, security, privacy, performance, and operational considerations.
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

Separate blockers from implementation-local detail, optional hardening, style,
and follow-up work. State explicitly when implementation may begin.

Issue: <url>

--- implementation/test plan ---
<complete plan>
```

Apply the three-round budget and stable ledger from `review-convergence.md`. A plan `critical-late-finding` must identify the exact criterion, code path, contract, or source; the concrete implementation failure; and why it must be resolved before implementation. Record `late-nonblocking` and `out-of-scope` work without silently changing the issue.

The second submission includes the complete current plan, ledger, revision summary, and verified repository evidence.

### Third submission — final plan convergence

```text
This is the final implementation/test-plan convergence review. The issue is
frozen. Do not restart design review, reopen resolved findings without evidence,
or add optional scope.

Review only unresolved ledger findings, revision regressions, new authoritative
evidence, and proven critical late findings. For each blocker, give its ID,
classification, exact source, concrete implementation failure, why it blocks,
and the minimum correction.

Return exactly one verdict:
- READY: no admissible implementation blocker remains.
- CORRECT: only deterministic implementation-local corrections remain.
- ESCALATE: a product decision, material trade-off, or fundamental re-plan is
  required.

Do not request another full review.

Issue: <url>

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

If implementation reveals a material architecture, public-contract, migration, security, or test-strategy change, use a remaining Phase 2 round only when available. After budget exhaustion, continue only for a deterministic in-scope correction verified from authoritative evidence and covered later by tests and PR review. A fresh broad review or missing product decision requires one checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`; never reset automatically.

## Phase 4 — Publish the remote draft PR

Commit and push the implementation branch, then open a **draft** PR using the repository template as a contract. Its body must reference the issue, summarize implementation and justified plan deviations, map every acceptance criterion to code/tests, list local and CI-only/manual validation, and record risks and deferred follow-ups.

Read the remote PR back, verify rendered body and metadata, record the pushed head SHA, and confirm the remote diff matches intended local scope. Relay reviews that remote PR and exact head, never an unpushed local substitute.

## Phase 5 — CI, relay PR review, and threads

Start required-CI inspection and the initial PR review from the same remote draft.

### Initial PR review

```text
Act as a strict code reviewer for this draft PR and its frozen agent-ready
issue.

Return the complete set of currently identifiable blockers. Check acceptance
coverage, plan deviations, tests, and correctness, compatibility, security,
performance, and maintainability. Give every blocker a stable ID, severity,
exact file/code path/input-state sequence or failing check, expected versus
actual failure, affected criterion or contract, why this PR must fix it, and the
minimum correction.

Separate blockers from optional hardening, style, refactoring, and follow-up
work. Return READY_FOR_HUMAN_REVIEW when no blocker remains and list risks.

PR: <url>
Issue: <url>
Current pushed head: <sha>
```

Apply the shared three-round protocol. The PR ledger records classification/severity, contract impact, status, reviewed/fix heads, disposition, and evidence. A PR `critical-late-finding` may block only with exact code location/path, triggering input/state/call sequence, expected versus actual failure, acceptance or contract impact, and why this PR must fix it.

Fix verified blockers, validate, commit, and push; verify disputed repository facts locally; record non-blocking work or scope expansion without adopting it mechanically. A readiness verdict applies only to its exact pushed head.

The second full review includes the PR URL, previous and current heads, complete ledger, fix summary, and head-to-head diff. It verifies prior findings, revision regressions, and new evidence without renaming or reopening findings silently.

### CI and GitHub review threads

In parallel:

- Wait for required CI to reach a terminal state; distinguish PR-caused failures from external/pre-existing failures; fix PR-caused failures and rerun affected validation and relay review within the remaining budget when implementation changed materially.
- Treat CI-only coverage as unverified until its remote check succeeds.
- Query all paginated `PullRequestReviewThread` nodes through GitHub GraphQL and use `isResolved`; REST comments do not expose thread resolution.
- For each unresolved thread, fix actionable findings or reply inline with the concrete reason for rejecting/deferring them. Reply and resolution are separate actions; resolve only when policy permits and the finding is actually handled.

The gate is no **unaddressed actionable thread**, not mechanically zero unresolved threads. Answered reviewer-owned unresolved threads appear in handoff. Material thread fixes use only remaining full-review budget; after exhaustion, use targeted closure only when eligible or keep the draft blocked.

### Third full review — final PR convergence

Spend the third round only on an evidence-stable candidate head after complete relevant local validation, successful required CI, a full actionable-thread sweep, and any resulting fixes/checks.

```text
This is the final convergence review for the draft PR. Do not restart broad
review, reopen resolved findings without evidence, or add optional scope.

Review only unresolved ledger findings, blocker-level regressions from the
latest fixes, new CI/test/code evidence, proven critical late findings, and
acceptance or repository-contract violations on the current head.

For each blocker, give its ID and classification, exact path and trigger,
expected versus actual failure, affected criterion or contract, why it blocks,
and the minimum correction.

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

--- finding ledger ---
<complete ledger>

--- fix summary and diff ---
<summary and diff>
```

If external CI or review infrastructure prevents an evidence-stable candidate, preserve the remaining round and return `BLOCKED_HANDOFF` instead of spending it ceremonially.

### Targeted closure

Only third-round `CORRECT_AND_CLOSE` permits one targeted closure check; it is not a fourth full review. Apply only the named minimum corrections, run affected local validation, push, wait for required CI, and sweep threads. An unrelated substantive change invalidates targeted closure as a broad-review substitute and leaves the PR blocked unless the user authorizes new budget.

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

Normalize `CLOSED` to `READY_FOR_HUMAN_REVIEW` for that exact head. A remaining or fix-caused blocker yields `BLOCKED_HANDOFF`; non-blocking suggestions become risk/follow-up. If a severe in-scope defect appears after budget exhaustion, fix and test it, but the new head lacks a clean verdict and remains blocked unless the user authorizes new review budget.

Do not ask relay whether `auto` may continue. Apply and record the shared agent-owned continuation decision. In `auto`, accepted blockers are fixed without routine checkpoints; unsupported preferences do not block; authority blockers, absolute disagreements, or inability to obtain a required clean exact-head verdict produce one consolidated `BLOCKED_HANDOFF`.

### Final readiness gate

Before classification:

1. Re-read required checks and paginate review threads again.
2. Update PR summary, acceptance mapping, validation evidence, plan deviations, and risks after all fixes.
3. Read the remote PR back and verify rendered body, metadata, and diff against the current head.

`READY_FOR_HUMAN_REVIEW` requires green required checks, no agent-verified blocker on the exact relay-approved head, every actionable thread fixed or deliberately answered, complete acceptance coverage, and a remote PR body that describes that head.

Otherwise return `BLOCKED_HANDOFF` with exact evidence and keep the PR draft. Never treat exhausted rounds as approval, mark ready, merge, or close the issue autonomously.

## Phase 6 — Handoff

Report:

1. Execution mode and `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.
2. Draft PR URL, current head, and relay-reviewed head if different.
3. Implementation summary and acceptance-to-code/test mapping.
4. Local validation, CI, and actionable-thread status.
5. Material plan deviations.
6. Relay verdict, full-round count, and targeted closure result.
7. Agent continuation decision, risks, deferred work, blockers, and answered-but-unresolved reviewer-owned threads.

The user owns final human review, `gh pr ready`, and merge.
