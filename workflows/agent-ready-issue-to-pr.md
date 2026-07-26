# Workflow: Agent-ready issue → reviewed plan → implementation → draft PR

**References**:

- Relay agent usage patterns: [`agent-instructions.md`](../agent-instructions.md)
- Shared execution modes: [`workflows/README.md`](./README.md#execution-modes)
- Rough-issue refinement workflow: [`issue-to-pr.md`](./issue-to-pr.md)

---

## What this workflow is

This is the shared implementation workflow for a GitHub issue whose product decisions, scope, and acceptance criteria are already settled.

It does not repeat decision-point discovery or rewrite the issue. It reviews how the fixed issue maps onto the current repository, then continues autonomously through implementation and tests, validation, a remote draft PR, CI, relay code review, review-thread handling, and user handoff.

The implementation-plan review is an engineering gate, not a new product-design phase and not a routine user checkpoint.

In `default`, preserve the explicit checkpoints and escalation behavior below. In `auto`, continue without routine user intervention through either `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`; execution mode does not change review budgets or quality gates.

## When to use / not to use

**Use** when:

- The issue has a clear problem statement, explicit scope and non-goals, testable acceptance criteria, and no unresolved product decisions.
- The expected change is non-trivial enough that repository boundaries, compatibility, sequencing, or validation deserves a second look.
- The user has authorized implementation and relay review.

**Do not use** when:

- The issue is a placeholder or still has material scope or acceptance-criteria questions. Use [`issue-to-pr.md`](./issue-to-pr.md).
- The work is exploratory and cannot yet be expressed as a fixed implementation contract.
- The change is trivial enough that plan-review overhead exceeds its implementation risk.
- The user explicitly asked to implement without relay or without this workflow.

Readiness is determined from the issue body and authoritative repository context, not from a label alone.

## Preconditions

- The authoritative issue is available through a GitHub URL or as complete text.
- Repository instructions, relevant design contracts, and declared dependencies are available to the agent.
- gpt-relay is reachable.
- The user has supplied a non-paused, task-specific ChatGPT session. Do not select an idle or previous-task session on the user's behalf.
- **Pin the supplied session before Phase 1 and reuse it for implementation-plan and PR review.**
- Record the execution mode before Phase 1, or preserve the mode inherited from `issue-to-pr.md`. Use `default` when none is specified.

---

## Phase 1 — Readiness check and implementation/test plan

Read the complete issue, repository instructions, relevant architecture or contract documents, current implementation, and nearby tests.

Confirm that:

- Scope and non-goals are explicit enough to prevent accidental expansion.
- Acceptance criteria are concrete and testable.
- No product, policy, UX, or public-contract decision remains open.
- Dependencies exist or the issue defines their handling.

This is a classification check, not issue refinement. Do not rewrite or silently reinterpret the issue.

If the issue is not actually ready, identify the complete set of missing decisions and recommend [`issue-to-pr.md`](./issue-to-pr.md) when broader refinement is needed. In `default`, present one consolidated checkpoint. In `auto`, do not silently rewrite a supposedly frozen issue; complete independent safe analysis and end with `BLOCKED_HANDOFF`.

If it is ready, choose the plan-creation path before drafting implementation opinions.

### Standard plan path — agent drafts the plan

Use the standard path when the change is narrow, follows an established repository pattern, has a largely obvious implementation path, and does not cross a high-risk boundary.

The agent inspects the repository and writes the implementation/test plan. Phase 2 then uses relay as an independent reviewer of that concrete artifact.

### High-risk plan path — parallel independent discovery

Use parallel discovery when one or more of these signals apply:

- The change affects a public API, schema, persisted format, migration, or compatibility boundary.
- Security, privacy, concurrency, recovery, or state consistency is material.
- The implementation crosses repositories or several independently owned components.
- Multiple substantially different implementation approaches appear viable.
- Choosing the wrong approach would cause expensive rework.
- The issue clearly defines what to deliver, but the implementation path remains non-obvious.

Follow the discussion-mode barriers from `agent-instructions.md`:

1. Before the agent writes implementation opinions, submit a context-only relay task containing the authoritative issue URL and objective repository constraints. Ask relay to independently identify viable approaches, repository boundaries, risks, and test blind spots—not to produce the authoritative final plan.
2. After submission, the agent independently inspects the repository and writes its complete implementation/test plan to a visible draft.
3. The agent draft must be persisted before reading relay's response.
4. Compare the outputs, verify relay-only repository claims locally, and incorporate justified blind spots or alternatives into one agent-owned plan.
5. If the outputs expose a genuine product decision rather than an implementation choice, stop dependent work. Use one consolidated checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.

Prompt skeleton:

```text
Independently analyze implementation approaches, repository boundaries,
compatibility or migration risks, failure paths, and test blind spots for the
agent-ready issue below.

Do not assume or accommodate an existing agent approach, and do not redesign
the frozen product scope. Your output is an independent blind-spot check for the
final implementation/test plan, not the authoritative plan.

Issue: https://github.com/<org>/<repo>/issues/<n>
```

Do not use parallel discovery merely because the issue is non-trivial. It is a risk-triggered escalation, not the default ceremony.

### The resulting plan

In either plan-creation path, produce one concise, visible, agent-owned implementation/test plan containing:

1. Affected components and expected files.
2. Implementation sequence and key engineering choices.
3. A mapping from every acceptance criterion to production behavior and tests.
4. Happy paths, boundaries, failure modes, regression cases, and relevant concurrency or state transitions.
5. Compatibility, migration, security, privacy, performance, and operational considerations that apply.
6. Focused validation during implementation and the complete relevant validation before publication.
7. CI-only or manual validation that cannot be reproduced locally.
8. Known risks and assumptions.

Keep the plan proportional to the change. It should expose a wrong implementation path without becoming a second issue body. Parallel discovery produces input to this plan, not a competing second plan.

## Phase 2 — Relay reviews the implementation/test plan

Send relay the authoritative issue URL and the complete, agent-owned plan. This review is required in both creation modes, including after parallel discovery. Ask relay to review the implementation approach against the frozen issue and current repository without reopening settled product scope.

```text
Act as a strict implementation and test-plan reviewer for the agent-ready issue
below.

The issue scope and acceptance criteria are frozen; do not redesign the product
requirements. Focus on:
- complete coverage of every acceptance criterion;
- alignment with repository boundaries and existing contracts;
- missing compatibility, migration, failure-path, security, test, or validation
  work;
- implementation or test ordering that could create unnecessary rework.

Return the complete set of currently identifiable blocking findings rather than
intentionally deferring known findings to later rounds. For each blocker, cite
the acceptance criterion, repository contract, or authoritative source; explain
the concrete implementation failure; and state the minimum required correction.

Separate blockers from implementation-local details, optional hardening, style
preferences, and follow-up work. If no issue blocks implementation, state
explicitly that implementation can begin.

Issue: https://github.com/<org>/<repo>/issues/<n>

--- implementation/test plan ---
<complete plan>
```

### Review budget and finding ledger

Phase 2 allows at most **three full plan-review submissions**:

1. The initial complete review.
2. A first correction review.
3. A final convergence review.

Do not reset this budget when a later response introduces another finding. The budget limits unrestricted re-review; it does not make a real blocker non-blocking or force implementation to begin.

After the initial response, maintain a visible finding ledger. Give every finding a stable ID and record:

- classification and blocking rationale;
- cited acceptance criterion, repository contract, or authoritative source;
- status: `open`, `resolved`, `rejected`, `deferred`, or `disputed`;
- the plan sections changed;
- the agent's disposition and local verification evidence.

Use a compact ledger such as:

| ID | Classification / basis | Status | Plan sections | Disposition and evidence |
|---|---|---|---|---|
| `P1` | `<initial blocker or later-round class>` | `<status>` | `<sections>` | `<agent action and verified source>` |

For the second and third submissions, include the latest complete plan, the ledger, and a concise revision summary. Relay must reconcile prior finding IDs instead of silently renaming or reopening them.

Any blocker first raised after the initial review must be classified as one of:

- `revision-regression` — directly introduced by the latest plan revision;
- `new-evidence` — supported by newly verified repository evidence that was not reasonably available in the earlier round;
- `critical-late-finding` — discoverable earlier, but supported by concrete evidence that the plan would violate an acceptance criterion or repository contract, omit a required failure path, or create a severe implementation risk;
- `late-nonblocking` — a late implementation preference, optional hardening idea, or follow-up that is not required before implementation;
- `out-of-scope` — requires changing frozen issue scope or acceptance criteria.

An unresolved prior blocker, `revision-regression`, `new-evidence`, or `critical-late-finding` can block Phase 2. A `critical-late-finding` has a high burden of proof: it must cite the exact acceptance criterion, code path, repository contract, or authoritative source; explain the concrete failure; and show why implementation must address it now. Timing alone neither admits nor waives a real blocker. Treat `late-nonblocking` and `out-of-scope` findings as deferred work, remaining risk, or a product ambiguity requiring the user, not as silent plan expansion.

Evaluate every response rather than accepting it mechanically:

- Real implementation or coverage gap → update the plan and request another review only while the three-submission budget remains.
- Repository fact that can be verified locally → inspect the authoritative code or document before changing the plan.
- Suggestion that changes frozen scope → do not adopt it silently; record it as out of scope or ask the user if it reveals a genuine product ambiguity.
- Style preference with no correctness or maintainability impact → note it and continue.

### Third submission — final convergence review

The third submission is not another unrestricted review. Send the complete plan, ledger, and latest revision summary with this prompt:

```text
This is the final convergence review for the implementation/test plan.

The issue scope and acceptance criteria are frozen. Do not restart a broad
design review, reopen resolved findings without new evidence, or introduce
optional scope.

Review only:
1. Whether previously accepted blocking findings are now resolved.
2. Whether the latest plan revisions directly introduced a new implementation
   blocker.
3. Whether newly verified repository evidence exposes a blocker that could not
   reasonably have been established in the earlier rounds.

For every remaining blocker, provide:
- finding ID;
- classification: carried, revision-regression, new-evidence, or
  critical-late-finding;
- the exact acceptance criterion, repository contract, or authoritative source;
- the concrete implementation failure that would result;
- why this blocks implementation rather than being an implementation-local
  detail, optional hardening, style preference, or follow-up;
- the minimum required correction.

A critical-late-finding must include concrete evidence that the plan would
violate an acceptance criterion or repository contract, omit a required failure
path, or create a severe implementation risk. Do not promote a late preference
or optional improvement into a blocker.

Return exactly one convergence verdict:
- READY: no admissible implementation blocker remains.
- CORRECT: one or more admissible blockers remain, but each has a deterministic,
  implementation-local correction that does not change frozen scope or a
  material contract or risk boundary.
- ESCALATE: one or more admissible blockers require a product decision,
  material trade-off, or fundamental re-plan.

Do not request another full review round.

Issue: https://github.com/<org>/<repo>/issues/<n>

--- finding ledger ---
<complete ledger>

--- latest revision summary ---
<changes since the previous round>

--- implementation/test plan ---
<complete plan>
```

### Decision after the review budget is exhausted

Relay wording is evidence, not an automatic veto. After the third submission, the agent makes one explicit decision:

- **No agent-verified admissible blocker remains** → close the ledger and begin implementation, even if relay still lists non-blocking preferences.
- **A real blocker has a deterministic, implementation-local correction** → make the minimum plan correction, verify it against the cited source and affected acceptance criteria, record it in the ledger, and begin implementation without another unrestricted plan review. Ensure later tests and PR review cover the corrected area.
- **A blocker changes product scope, a public contract, compatibility or migration policy, security/privacy posture, or another material trade-off** → in `default`, present one consolidated checkpoint with the concrete decision and both rationales; in `auto`, record an authority blocker and end with `BLOCKED_HANDOFF` after completing independent safe work.
- **Agent and relay disagree about a repository fact or severity** → inspect authoritative evidence and make an agent-owned semantic decision. Escalate only when the disagreement meets the workflow definition of absolute disagreement: use one consolidated checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.
- **Several fundamental blockers show that the plan or issue is not actually ready** → in `default`, stop implementation and present one consolidated return-to-planning recommendation; in `auto`, do not reset the review budget or silently refine the frozen issue, and end with `BLOCKED_HANDOFF`.

Never start a fourth unrestricted Phase 2 review. The maximum-round rule is a convergence and escalation boundary, not an automatic pass.

The three-review budget belongs to the current plan revision cycle. Relay feedback, deterministic corrections, implementation commits, and selection of `auto` do not reset it. A new full plan-review cycle requires an explicit user-authorized material change to the issue or engineering risk boundary; carry the prior finding ledger forward and record the reason.

There is no routine user approval checkpoint after plan review in either mode. Once this gate passes, proceed directly to implementation.

## Phase 3 — Implement code and tests, then validate

Implement production behavior and tests together according to the reviewed plan:

- Keep changes within the issue contract.
- Prefer focused tests during iteration and run relevant static checks before committing.
- Use small, semantic commits when the repository workflow calls for commits during implementation.
- Before publication, run the complete relevant test, lint, typecheck, build, format, and contract or fixture checks required by the repository.
- Verify every acceptance criterion against the resulting code and tests.
- For bug fixes, demonstrate the regression test failing before the fix when practical. For new behavior, demonstrate the acceptance and failure paths directly.

Do not require artificial “naive/no-op implementation” evidence when it would not meaningfully prove the test.

Plans may evolve when the code reveals better implementation-local details. Update the visible plan and continue when the change preserves issue scope and acceptance-criteria coverage.

If implementation reveals a material architecture, public-contract, migration, security, or test-strategy change:

- Use a remaining Phase 2 submission only when the original review budget has not been exhausted.
- After the budget is exhausted, continue only when the change has a deterministic in-scope correction that the agent can verify against authoritative evidence and later cover in tests and PR review.
- If a fresh broad plan review or missing product decision is genuinely required, do not reset the budget automatically. Use one consolidated checkpoint in `default`, or finish independent safe work and return `BLOCKED_HANDOFF` in `auto`.

## Phase 4 — Push and open a remote draft PR

Commit and push the implementation branch, then open a **draft** PR using the repository's PR template as a contract.

The PR body should:

- Reference the issue.
- Summarize the implementation and justified plan deviations.
- Map every acceptance criterion to code and tests.
- List local validation and any CI-only or manual validation.
- Call out known risks and explicitly deferred follow-ups without expanding the current PR.

After publishing:

1. Read the remote PR back and verify its rendered body and metadata.
2. Record the pushed head SHA.
3. Confirm the remote diff matches the intended local scope.

Relay must review the remote PR at the pushed head. Never substitute an unpushed local diff for the review target.

## Phase 5 — CI, relay PR review, and review-thread handling

Start CI inspection and relay review from the same remote draft PR. CI state and GitHub review threads are independent factual gates; they do not consume relay review rounds.

Send the PR URL and exact pushed head to the pinned relay session:

```text
Act as a strict code reviewer for the draft PR below. It implements the
agent-ready issue whose implementation/test plan was reviewed earlier in this
session.

Check whether the implementation covers the issue acceptance criteria,
unintentionally diverges from the plan, has adequate tests, and avoids
correctness, compatibility, security, performance, or maintainability defects.

Return the complete set of currently identifiable blocking findings rather than
intentionally deferring known findings to later rounds. Give each finding a
stable ID. For every blocker, provide:
- severity and classification;
- exact file, code path, input/state/call sequence, or failing check;
- expected behavior and concrete actual or predicted failure;
- affected acceptance criterion or repository contract;
- why the current PR must fix it;
- the minimum required correction.

Separate blockers from non-blocking hardening, style or refactoring preferences,
and follow-up work. If there are no blocking issues, return
READY_FOR_HUMAN_REVIEW and list the remaining risks.

PR: <url>
Issue: <url>
Current pushed head: <sha>
```

### Review budget and finding ledger

Phase 5 allows at most **three full relay PR reviews**:

1. The initial comprehensive review.
2. A correction and regression review.
3. A final convergence review.

Do not reset this budget when a new commit or later response introduces another finding. The budget limits unrestricted re-review; it never makes a real defect non-blocking or permits an automatic pass.

Maintain a visible finding ledger after the initial response. Preserve stable finding IDs and record:

- classification and severity;
- blocking rationale and affected acceptance criterion or repository contract;
- status: `open`, `resolved`, `rejected`, `deferred`, or `disputed`;
- first reviewed head and, when applicable, fix head;
- agent disposition and verification evidence.

Use a compact ledger such as:

| ID | Classification / severity | Status | Reviewed / fix head | Disposition and evidence |
|---|---|---|---|---|
| `R1` | `<class and severity>` | `<status>` | `<sha> / <sha>` | `<agent action and evidence>` |

Any finding first raised after the initial review must be classified as one of:

- `revision-regression` — directly introduced by a fix made during this review loop;
- `new-evidence` — supported by a new CI failure, test result, code path, or repository fact not reasonably available earlier;
- `critical-late-finding` — a concrete severe defect that was discoverable earlier but would make the current PR unsafe or violate an acceptance criterion or repository contract;
- `late-nonblocking` — a late improvement, hardening idea, maintainability preference, or low-impact risk;
- `out-of-scope` — valid work that is not required for the current issue to be correct.

A `critical-late-finding` may block despite being late, but it requires a high burden of proof: exact code location or path, triggering input/state/call sequence, expected versus actual failure, acceptance-criterion or contract impact, and why this PR must fix it. A label alone is not evidence.

Handle each response as follows:

- Real blocker → verify it locally, fix it, validate, commit, and push to the same branch.
- Non-blocking preference → adopt it only when justified; otherwise record it as remaining risk or follow-up.
- Scope expansion → defer it explicitly unless the current issue cannot be correct without it.
- Disputed repository fact → inspect the authoritative code, contract, test, or CI evidence before deciding.
- After every substantive push, record the new head. A readiness verdict is valid only for the exact pushed head it reviewed.

For the second full review, provide the PR URL, previous reviewed head, current pushed head, complete finding ledger, fix summary, and the diff between those heads. Ask relay to verify prior findings, inspect revision-caused regressions and new evidence, and complete its review without silently renaming or reopening resolved findings.

In parallel, inspect required checks:

- Wait for required CI to reach a terminal state.
- Investigate failures and distinguish PR-caused failures from external or pre-existing failures.
- Fix PR-caused failures and repeat the relevant validation and review.
- Treat CI-only coverage as unverified until the corresponding remote check succeeds.

Inspect GitHub review **threads**, not only the flat REST comment list:

1. Query `PullRequestReviewThread` through GitHub GraphQL and paginate all `reviewThreads`.
2. Use `isResolved` to identify unresolved threads; REST review-comment objects do not carry thread-resolution state.
3. For each unresolved thread, determine whether it is actionable.
4. Fix actionable findings, or reply inline with the concrete reason for deliberately deferring or rejecting them.
5. Resolve a thread only when repository policy permits and the finding has actually been handled. A reply and a resolution are separate actions.
6. Re-run relay review after fixes that materially change the implementation only within the remaining review budget. After the budget is exhausted, use the targeted closure check only when eligible; otherwise keep the PR draft and record a blocked handoff.

The gate is **no unaddressed actionable thread**, not mechanically zero unresolved threads. Reviewer-owned unresolved threads that have been answered must be listed in the handoff.

### Third full review — final convergence

Reserve the third full review until the candidate head is evidence-stable:

- Complete the full relevant local validation.
- Wait for required CI on that head to reach a successful terminal state.
- Perform a complete GitHub review-thread sweep, handle every actionable finding, and push any resulting fixes.
- If those fixes change the head, rerun the affected validation and required checks before spending the final full review.

If an external CI or review-system blocker prevents an evidence-stable candidate head, do not spend the third round merely to exhaust the budget; preserve the remaining review state and return `BLOCKED_HANDOFF`.

The third full review is not another unrestricted restart. Send the PR URL, current and previous heads, complete ledger, latest fix summary, and relevant head-to-head diff with this prompt:

```text
This is the final convergence review for the draft PR.

Do not restart a broad review, reopen resolved findings without concrete new
evidence, or add optional scope. Review only:
1. Unresolved findings already recorded in the ledger.
2. Concrete blocker-level regressions introduced by the latest fixes.
3. New CI, test, code-path, or repository evidence.
4. Acceptance-criterion or repository-contract violations on the current head.

Classify every finding first raised in this round as revision-regression,
new-evidence, critical-late-finding, late-nonblocking, or out-of-scope. A
critical-late-finding must include the exact code path or location, triggering
input/state/call sequence, expected versus actual failure, affected acceptance
criterion or contract, and why the current PR must fix it.

Return exactly one convergence verdict:
- READY_FOR_HUMAN_REVIEW: no blocking finding remains on the current pushed
  head.
- CORRECT_AND_CLOSE: only named blockers with deterministic, bounded fixes
  remain; list their IDs and the minimum corrections for a targeted closure
  check.
- BLOCKED_HANDOFF: the PR still has a blocker that cannot safely converge within
  the remaining bounded review process; explain the blocker and required next
  decision or work.

Do not request another full review round.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>

--- finding ledger ---
<complete ledger>

--- latest fix summary and head-to-head diff ---
<summary and diff>
```

### Optional targeted closure check

Only a third-round `CORRECT_AND_CLOSE` verdict permits **one targeted closure check**. This is not a fourth full review.

Apply the minimum corrections for the named finding IDs, run the affected local validation, commit and push them, wait for required CI on the fix head, and perform another GitHub review-thread sweep. Send the targeted closure request only after that head is evidence-stable:

If the closure-head sweep requires an unrelated substantive implementation change, the targeted closure is no longer an admissible substitute for broad review. Handle the concrete defect when it is in scope, but keep the PR in `BLOCKED_HANDOFF` unless the user explicitly authorizes a new review budget. Changes directly required by the named closure findings remain eligible.

```text
This is a targeted closure check, not a full PR review.

Review only:
1. Whether the named finding IDs are resolved on the current pushed head.
2. Whether their fix diff directly introduces a concrete blocker-level
   regression.

Do not reopen broad review, add style or refactoring advice, or introduce
unrelated findings. A new blocker is admissible only with the exact code path,
triggering input/state/call sequence, expected versus actual failure, and
acceptance-criterion or repository-contract impact.

Return exactly one verdict:
- CLOSED: every named blocker is resolved and the fix diff introduces no
  blocker-level regression.
- BLOCKED_HANDOFF: a named blocker remains or the fix directly introduces a
  proven blocker-level regression.

PR: <url>
Previous reviewed head: <sha>
Current pushed head: <sha>
Named finding IDs: <ids>

--- targeted fix diff ---
<diff>
```

After the targeted closure check:

- `CLOSED` may be normalized to `READY_FOR_HUMAN_REVIEW` for the exact reviewed head.
- If an original finding remains or its fix introduces a blocker, keep the PR draft and use `BLOCKED_HANDOFF`.
- Record any new non-blocking suggestion as remaining risk or follow-up.
- If a concrete severe defect is discovered after the review budget, fix and test it when the required correction is in scope, but do not restart the full relay loop automatically. The resulting head lacks a clean relay verdict and must remain a blocked draft handoff unless the user explicitly authorizes a new review budget.
- Never interpret exhausted review rounds as approval.

Do not submit a separate relay task asking whether `auto` execution may continue. After each relay response, the agent records and applies the semantic continuation decision defined in `workflows/README.md`.

In `auto`, a real accepted blocker is fixed without a user checkpoint; an unsupported preference is recorded and does not block; and an authority blocker, absolute disagreement, or inability to obtain a clean exact-head verdict ends in one consolidated `BLOCKED_HANDOFF` rather than an automatic review-budget extension.

Before classifying the final head, synchronize the remote PR body with the actual implementation:

1. Re-read required-check status and paginate review threads once more; handle any newly actionable result under the remaining review budget.
2. Update the implementation summary, acceptance-criteria mapping, validation evidence, material plan deviations, and remaining risks after all substantive review fixes.
3. Read the remote PR back and verify its rendered body and metadata.
4. Confirm that the remote diff and body both describe the exact current head.

A `READY_FOR_HUMAN_REVIEW` handoff requires all of:

- Required checks are green.
- No agent-verified, evidence-backed blocking finding remains unaddressed on the exact current pushed head, and relay returned `READY_FOR_HUMAN_REVIEW` or `CLOSED` for that head.
- Every actionable review thread has been fixed or deliberately answered.
- The issue acceptance criteria remain fully covered.
- The rendered remote PR body accurately describes the exact current head.

If the bounded review process ends with a verified blocker, an external CI blocker, an unaddressed actionable thread, or no clean relay verdict for the current head, terminate with `BLOCKED_HANDOFF`: keep the PR draft, report the exact blocker and evidence, and do not claim readiness. The user may explicitly authorize a new review budget after deciding how to proceed.

Do **not** merge the PR or mark it ready-for-review autonomously.

## Phase 6 — Hand off the draft PR

Present:

1. Execution mode and handoff status: `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`.
2. The draft PR link and exact current head SHA, plus the exact relay-reviewed head when different.
3. A concise implementation summary.
4. Acceptance-criteria coverage mapped to code and tests.
5. Local validation and required-CI status.
6. Material deviations from the reviewed plan.
7. Relay's final verdict, review-round count, and targeted closure result if used.
8. The final agent-owned continuation decision.
9. Remaining risks, deferred follow-ups, external blockers, open finding IDs, and answered-but-unresolved reviewer-owned threads.

The user owns final human review, `gh pr ready`, and merge decisions.

---

## Global rules

- **Treat the issue as a frozen contract.** Implement it; do not casually refine or rewrite it.
- **Preserve the selected `default` or `auto` mode across every phase and any composed workflow.**
- **`auto` changes checkpoint behavior, not finding admissibility, validation, review budgets, or exact-head gates.**
- **Never ask relay separately whether auto execution may continue; continuation is an agent-owned semantic decision.**
- **Default to agent-authored planning; use parallel independent discovery only for high-risk or non-obvious implementation paths.**
- **Parallel discovery informs one agent-owned plan and never replaces the final Phase 2 plan review.**
- **Plan review is mandatory for non-trivial work using this workflow, but routine user approval of the plan is not.**
- **Phase 2 permits at most three full plan-review submissions; after the final convergence review, proceed, make a deterministic verified correction, or escalate—never restart unrestricted review.**
- **Phase 5 permits at most three full relay PR reviews and, only after `CORRECT_AND_CLOSE`, one targeted closure check; never restart unrestricted review without explicit user authorization.**
- **Reserve the third full PR review for an evidence-stable head after required CI and the actionable-thread sweep.**
- **Review limits are convergence boundaries, not waivers: an evidence-backed PR blocker keeps the draft in `BLOCKED_HANDOFF`.**
- **CI failures and actionable GitHub review threads remain independent gates and do not consume relay review rounds.**
- **Implement tests with production behavior instead of bolting them on after the code is pushed.**
- **Never merge, close the issue, or mark the PR ready-for-review autonomously.**
- **Use the same user-supplied, task-specific relay session across plan and PR review.**
- **Review remote artifacts at an identified head SHA.**
- **Use GraphQL review-thread state for unresolved-thread gates; do not infer it from flat REST comments.**
- **If relay pauses or hits a captcha:** do not retry automatically; complete independent safe work, then use one consolidated checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`.
- **If readiness classification fails:** use one consolidated switch-to-`issue-to-pr.md` recommendation in `default`, or `BLOCKED_HANDOFF` in `auto`.
- **If implementation reveals a product decision:** relay review cannot substitute for product authority; use one consolidated checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.
