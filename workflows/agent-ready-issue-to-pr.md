# Workflow: Agent-ready issue → reviewed plan → implementation → draft PR

**References**:

- Relay agent usage patterns: [`agent-instructions.md`](../agent-instructions.md)
- Rough-issue refinement workflow: [`issue-to-pr.md`](./issue-to-pr.md)

---

## What this workflow is

This is the shared implementation workflow for a GitHub issue whose product decisions, scope, and acceptance criteria are already settled.

It does not repeat decision-point discovery or rewrite the issue. It reviews how the fixed issue maps onto the current repository, then continues autonomously through implementation and tests, validation, a remote draft PR, CI, relay code review, review-thread handling, and user handoff.

The implementation-plan review is an engineering gate, not a new product-design phase and not a routine user checkpoint.

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

---

## Phase 1 — Readiness check and implementation/test plan

Read the complete issue, repository instructions, relevant architecture or contract documents, current implementation, and nearby tests.

Confirm that:

- Scope and non-goals are explicit enough to prevent accidental expansion.
- Acceptance criteria are concrete and testable.
- No product, policy, UX, or public-contract decision remains open.
- Dependencies exist or the issue defines their handling.

This is a classification check, not issue refinement. Do not rewrite or silently reinterpret the issue.

If the issue is not actually ready, stop and identify the missing decisions. Recommend [`issue-to-pr.md`](./issue-to-pr.md) when broader refinement is needed.

If it is ready, choose the plan-creation mode before drafting implementation opinions.

### Default mode — agent drafts the plan

Use the default mode when the change is narrow, follows an established repository pattern, has a largely obvious implementation path, and does not cross a high-risk boundary.

The agent inspects the repository and writes the implementation/test plan. Phase 2 then uses relay as an independent reviewer of that concrete artifact.

### High-risk mode — parallel independent discovery

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
5. If the outputs expose a genuine product decision rather than an implementation choice, stop and ask the user.

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

In either mode, produce one concise, visible, agent-owned implementation/test plan containing:

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

Do not reset this budget when a later response introduces another finding. The
budget limits unrestricted re-review; it does not make a real blocker
non-blocking or force implementation to begin.

After the initial response, maintain a visible finding ledger. Give every
finding a stable ID and record:

- classification and blocking rationale;
- cited acceptance criterion, repository contract, or authoritative source;
- status: `open`, `resolved`, `rejected`, `deferred`, or `disputed`;
- the plan sections changed;
- the agent's disposition and local verification evidence.

Use a compact ledger such as:

| ID | Classification / basis | Status | Plan sections | Disposition and evidence |
|---|---|---|---|---|
| `P1` | `<initial blocker or later-round class>` | `<status>` | `<sections>` | `<agent action and verified source>` |

For the second and third submissions, include the latest complete plan, the
ledger, and a concise revision summary. Relay must reconcile prior finding IDs
instead of silently renaming or reopening them.

Any blocker first raised after the initial review must be classified as one of:

- `revision-regression` — directly introduced by the latest plan revision;
- `new-evidence` — supported by newly verified repository evidence that was not
  reasonably available in the earlier round;
- `late-finding` — discoverable earlier and not caused by the latest revision;
- `out-of-scope` — requires changing frozen issue scope or acceptance criteria.

Only an unresolved prior blocker, a `revision-regression`, or a
`new-evidence` finding can normally continue to block Phase 2. A `late-finding`
does not become blocking merely because it was labeled a blocker; the agent must
verify its concrete impact. Treat `out-of-scope` findings as deferred work or a
product ambiguity requiring the user, not as silent plan expansion.

Evaluate every response rather than accepting it mechanically:

- Real implementation or coverage gap → update the plan and request another review only while the three-submission budget remains.
- Repository fact that can be verified locally → inspect the authoritative code or document before changing the plan.
- Suggestion that changes frozen scope → do not adopt it silently; record it as out of scope or ask the user if it reveals a genuine product ambiguity.
- Style preference with no correctness or maintainability impact → note it and continue.

### Third submission — final convergence review

The third submission is not another unrestricted review. Send the complete plan,
ledger, and latest revision summary with this prompt:

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
- classification: carried, revision-regression, or new-evidence;
- the exact acceptance criterion, repository contract, or authoritative source;
- the concrete implementation failure that would result;
- why this blocks implementation rather than being an implementation-local
  detail, optional hardening, style preference, or follow-up;
- the minimum required correction.

Do not classify a late finding as blocking unless it is supported by new
evidence or was directly introduced by the latest revision.

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

Relay wording is evidence, not an automatic veto. After the third submission,
the agent makes one explicit decision:

- **No agent-verified admissible blocker remains** → close the ledger and begin
  implementation, even if relay still lists non-blocking preferences.
- **A real blocker has a deterministic, implementation-local correction** →
  make the minimum plan correction, verify it against the cited source and
  affected acceptance criteria, record it in the ledger, and begin
  implementation without another unrestricted plan review. Ensure later tests
  and PR review cover the corrected area.
- **A blocker changes product scope, a public contract, compatibility or
  migration policy, security/privacy posture, or another material trade-off** →
  present the concrete decision and both rationales to the user.
- **Agent and relay still disagree about a repository fact or severity** →
  present the authoritative evidence, impact, and competing rationale to the
  user rather than starting a fourth review.
- **Several fundamental blockers show that the plan or issue is not actually
  ready** → stop implementation and return to planning or `issue-to-pr.md` with
  the user's agreement.

Never start a fourth unrestricted Phase 2 review. The maximum-round rule is a
convergence and escalation boundary, not an automatic pass.

There is no routine user approval checkpoint after plan review. Once this gate passes, proceed directly to implementation.

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

Return to Phase 2 when a change materially alters architecture, a public contract, data migration, security behavior, or the test strategy. Stop and ask the user when implementation exposes a missing product decision.

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

Start CI inspection and relay review from the same remote draft PR.

Send the PR URL to the pinned relay session:

```text
Act as a strict code reviewer for the draft PR below. It implements the
agent-ready issue whose implementation/test plan was reviewed earlier in this
session.

Check whether the implementation covers the issue acceptance criteria,
unintentionally diverges from the plan, has adequate tests, and avoids
correctness, compatibility, security, performance, or maintainability defects.
List required changes first. If there are no blocking issues, state explicitly
that it is safe to request human review and list the remaining risks.

PR: <url>
```

Handle the review loop:

- Real issue → fix it, validate, commit, push to the same branch, then request another review of the same PR.
- Non-blocking preference → adopt it only when justified; otherwise record the reasoning for handoff.
- Scope expansion → defer it explicitly unless the current issue cannot be correct without it.
- After every substantive push, update the recorded head and ensure the final relay conclusion applies to that exact head.

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
6. Re-run relay review after fixes that materially change the implementation.

The gate is **no unaddressed actionable thread**, not mechanically zero unresolved threads. Reviewer-owned unresolved threads that have been answered must be listed in the handoff.

Terminate only when:

- Required checks are green, or an external blocker is clearly reported to the user instead of claiming readiness.
- Relay reports no blocking issue on the exact current pushed head.
- Every actionable review thread has been fixed or deliberately answered.
- The issue acceptance criteria remain fully covered.

Do **not** merge the PR or mark it ready-for-review autonomously.

## Phase 6 — Hand off the draft PR

Present:

1. The draft PR link and exact reviewed head SHA.
2. A concise implementation summary.
3. Acceptance-criteria coverage mapped to code and tests.
4. Local validation and required-CI status.
5. Material deviations from the reviewed plan.
6. Relay's final conclusion.
7. Remaining risks, deferred follow-ups, external blockers, and answered-but-unresolved reviewer-owned threads.

The user owns final human review, `gh pr ready`, and merge decisions.

---

## Global rules

- **Treat the issue as a frozen contract.** Implement it; do not casually refine or rewrite it.
- **Default to agent-authored planning; use parallel independent discovery only for high-risk or non-obvious implementation paths.**
- **Parallel discovery informs one agent-owned plan and never replaces the final Phase 2 plan review.**
- **Plan review is mandatory for non-trivial work using this workflow, but routine user approval of the plan is not.**
- **Phase 2 permits at most three full plan-review submissions; after the final convergence review, proceed, make a deterministic verified correction, or escalate—never restart unrestricted review.**
- **Implement tests with production behavior instead of bolting them on after the code is pushed.**
- **Never merge, close the issue, or mark the PR ready-for-review autonomously.**
- **Use the same user-supplied, task-specific relay session across plan and PR review.**
- **Review remote artifacts at an identified head SHA.**
- **Use GraphQL review-thread state for unresolved-thread gates; do not infer it from flat REST comments.**
- **If relay pauses or hits a captcha:** stop, tell the user, and do not retry automatically.
- **If readiness classification fails:** stop or switch to `issue-to-pr.md` with the user's agreement.
- **If implementation reveals a product decision:** stop and ask the user. Relay review cannot substitute for product authority.
