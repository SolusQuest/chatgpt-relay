# Workflow: Rough issue → agent-ready issue → implementation → PR

**References**:

- Relay agent usage patterns: [`agent-instructions.md`](../agent-instructions.md)
- Shared execution modes: [`workflows/README.md`](./README.md#execution-modes)
- Shared implementation and PR workflow: [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md)

---

## What this workflow is

This workflow turns a placeholder or under-specified GitHub issue into an agent-ready issue, then continues through the shared implementation workflow.

Its responsibility is refinement: discover the material decisions, turn them into an explicit issue contract, satisfy the selected publication checkpoint, and publish the authorized issue. It does not maintain a second copy of implementation, CI, PR-review, or handoff rules; after refinement it delegates those phases to [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md).

Use this slower path when getting scope and acceptance criteria wrong would be more expensive than discussing them first.

In `default` mode, the exact refined issue body passes through a user-approval checkpoint before publication. In `auto` mode, the user's initial authorization replaces that routine checkpoint only when refinement stays within the stated product intent and no user-owned decision remains.

## When to use / not to use

**Use** when:

- The issue is a placeholder, rough draft, or problem report that is not yet safe to implement.
- Scope, non-goals, acceptance criteria, compatibility, or product behavior contains material ambiguity.
- The user has authorized issue refinement, implementation, and relay review.

**Do not use** when:

- The issue already has settled scope, testable acceptance criteria, and no unresolved product decisions. Start with [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md).
- The change is a trivial typo, one-line configuration edit, or obvious urgent hotfix.
- The work is exploratory and its deliverable is learning rather than an implementation contract.
- The user explicitly asked to skip refinement or relay.

If routing is unclear, inspect the full issue and repository context first. Route by the actual readiness of the issue, not by labels alone.

## Preconditions

- The full issue is available through a GitHub URL or as complete text.
- Repository instructions and relevant product, architecture, or contract documents are available to the agent.
- gpt-relay is reachable.
- The user has supplied a non-paused, task-specific ChatGPT session. Do not select an idle or previous-task session on the user's behalf.
- **Pin the supplied session before Phase 1 and reuse it throughout this workflow and the downstream agent-ready workflow.**
- Record the execution mode before Phase 1. Use `default` when none is specified, and pass the same mode to the downstream workflow.

---

## Phase 1 — Independent decision-point discovery

Goal: identify the material decisions that must be explicit before the issue can become an implementation contract.

Use the discussion-mode barriers from `agent-instructions.md`:

1. Submit the full issue or accessible issue URL to relay before writing any agent opinion. Ask relay for an independent list of blocking decision points.
2. After submission, independently inspect the repository and write the agent's own decision-point list to a visible draft before reading relay's reply.
3. Compare the two lists and classify overlap, agent-only points, relay-only points, and substantive conflicts.
4. Discuss only material gaps or conflicts. Do not spend additional rounds reconciling style or wording.

Review these categories where relevant:

- Problem and intended outcome.
- In-scope and out-of-scope behavior.
- Testable acceptance criteria.
- Public contracts, compatibility, migration, and rollout.
- Failure modes, security, privacy, performance, and operational constraints.
- Dependencies, sequencing, naming, and explicit non-goals.

Terminate when:

- No unresolved decision blocks drafting a complete issue contract.
- A further round adds no substantive point.
- Remaining differences are wording or optional follow-up suggestions.

Use at most three discussion rounds after the independent outputs. A further relay discussion does not become available merely because the workflow uses `auto`.

Any product, policy, UX, public-contract, or scope trade-off belongs to the user unless the user explicitly delegated that exact decision boundary. Relay and the agent may clarify the trade-off but must not silently decide it.

- In `default`, batch every unresolved material decision and substantive disagreement into one user checkpoint with both rationales.
- In `auto`, resolve repository facts and deterministic in-scope choices from authoritative evidence. If an authority blocker or absolute disagreement remains, complete any independent safe work and end with one consolidated `BLOCKED_HANDOFF`; do not ask a sequence of questions or add relay rounds.

## Phase 2 — Draft and review the agent-ready issue

Create the issue body as a visible local draft using the target repository's issue template and conventions.

The draft should contain:

1. Problem and motivation.
2. Scope, exclusions, and non-goals.
3. Concrete, testable acceptance criteria.
4. Dependencies and sequencing constraints.
5. Compatibility, migration, security, or operational requirements where applicable.
6. Risks and explicitly deferred follow-ups.
7. Resolved decisions needed to prevent implementation ambiguity.

Do not leave unresolved product decisions disguised as “open questions.” If a
user decision is still required, use one consolidated Phase 1 checkpoint in
`default`, or record an authority blocker and return `BLOCKED_HANDOFF` in
`auto`.

Send the complete draft to the pinned relay session for strict PM and engineering review:

```text
Act as a strict product and engineering reviewer for the refined issue body
below.

Focus on scope, non-goals, executable acceptance criteria, dependencies, risks,
compatibility, and any ambiguous decision that could block implementation.

Return the complete set of currently identifiable blocking findings rather than
intentionally deferring known findings to later rounds. For each blocker, cite
the issue section, repository contract, template rule, dependency, or other
authoritative source; explain the concrete implementation ambiguity or failure;
and state the minimum required correction.

Separate blockers from optional enhancements, style preferences, wording
polish, and follow-up work. If there are no blocking findings, state explicitly
that the issue is agent-ready.

Issue or placeholder: <url if available>

--- refined issue draft ---
<complete draft>
```

### Review budget and finding ledger

Phase 2 allows at most **three full issue-body review submissions**:

1. The initial complete contract review.
2. A first correction review.
3. A final contract-convergence review.

Do not reset this budget when a later response introduces another finding. The
budget limits unrestricted re-review; it does not make a real contract blocker
non-blocking, bypass a missing product decision, or authorize publication.

After the initial response, maintain a visible finding ledger. Give every
finding a stable ID and record:

- classification and blocking rationale;
- cited issue section, repository contract, template rule, dependency, or other
  authoritative source;
- status: `open`, `resolved`, `rejected`, `deferred`, or `disputed`;
- the issue sections changed;
- the agent's disposition and verification evidence.

Use a compact ledger such as:

| ID | Classification / basis | Status | Issue sections | Disposition and evidence |
|---|---|---|---|---|
| `I1` | `<initial blocker or later-round class>` | `<status>` | `<sections>` | `<agent action and verified source>` |

For the second and third submissions, include the latest complete issue body,
the ledger, and a concise revision summary. Relay must reconcile prior finding
IDs instead of silently renaming or reopening them.

Any blocker first raised after the initial review must be classified as one of:

- `revision-regression` — directly introduced by the latest issue-body revision;
- `new-evidence` — supported by newly verified repository, dependency, or
  contract evidence that was not reasonably available in the earlier round;
- `critical-late-finding` — discoverable earlier, but supported by concrete
  evidence that the current issue would remain materially ambiguous,
  untestable, internally contradictory, or unsafe to implement;
- `late-nonblocking` — a late wording improvement, optional hardening idea, or
  follow-up that is not required for an agent-ready contract;
- `out-of-scope` — requires adding behavior outside the proposed scope;
- `user-decision` — exposes a product, policy, UX, public-contract, or scope
  trade-off that the agent cannot settle.

An unresolved prior blocker, `revision-regression`, `new-evidence`,
`critical-late-finding`, or `user-decision` can block contract convergence. A
`critical-late-finding` has a high burden of proof: it must cite the exact issue
section or authoritative source, the implementation ambiguity or failure that
would result, the affected acceptance criterion or contract boundary, and why
the current issue must resolve it. Timing alone neither admits nor waives a real
blocker. Record `late-nonblocking` and `out-of-scope` findings as excluded,
deferred, or remaining risk.

Evaluate the response semantically:

- Real contract gap → revise the draft and request another review only while the three-submission budget remains.
- Missing user decision → collect the concrete choice for the consolidated
  `default` checkpoint or `auto` blocked handoff.
- Scope expansion or optional follow-up → record it as excluded or deferred.
- Style-only preference → adopt only when it improves the repository's issue contract.

### Third submission — final contract-convergence review

The third submission is not another unrestricted issue review. Send the complete
issue body, ledger, and latest revision summary with this prompt:

```text
This is the final contract-convergence review for the agent-ready issue body.

Do not restart broad product discovery, reopen resolved findings without new
evidence, or introduce optional scope.

Review only:
1. Whether previously accepted blocking findings are now resolved.
2. Whether the latest issue-body revisions directly introduced a contradiction,
   ambiguous implementation decision, or untestable acceptance criterion.
3. Whether newly verified repository, dependency, or contract evidence exposes
   a blocker that could not reasonably have been established earlier.

For every remaining blocker, provide:
- finding ID;
- classification: carried, revision-regression, new-evidence,
  critical-late-finding, or user-decision;
- the exact issue section, repository contract, template rule, dependency, or
  authoritative source;
- the concrete implementation ambiguity or failure that would result;
- why this blocks an agent-ready contract rather than being optional scope,
  wording polish, style preference, or follow-up work;
- the minimum required correction or user decision.

A critical-late-finding must include concrete evidence of a material ambiguity,
untestable requirement, contradiction, or unsafe implementation outcome. Do not
promote a late preference or optional improvement into a blocker.

Return exactly one convergence verdict:
- READY: no admissible contract blocker remains; the exact issue body can be
  presented to the user for approval.
- CORRECT: one or more admissible blockers remain, but each has a deterministic,
  contract-local correction that does not require a new product decision.
- ESCALATE: one or more admissible blockers require a product, policy, UX,
  public-contract, or scope decision from the user, or a fundamental re-draft.

Do not request another full issue-body review round.

Issue or placeholder: <url if available>

--- finding ledger ---
<complete ledger>

--- latest revision summary ---
<changes since the previous round>

--- refined issue draft ---
<complete draft>
```

### Decision after the review budget is exhausted

Relay wording is evidence, not an automatic veto. After the third submission,
the agent makes one explicit decision:

- **No agent-verified admissible blocker remains** → close the ledger and
  proceed to the Phase 3 checkpoint for the selected mode.
- **A real blocker has a deterministic, contract-local correction** → make the
  minimum correction, verify that every acceptance criterion remains
  implementable and testable, record it in the ledger, and proceed to the
  selected Phase 3 checkpoint without another unrestricted relay review.
- **A blocker requires a product, policy, UX, public-contract, or scope
  decision** → in `default`, return to one consolidated Phase 1 user checkpoint;
  in `auto`, record an authority blocker and end with `BLOCKED_HANDOFF` after
  completing independent safe work.
- **Agent and relay disagree about a repository fact or blocker severity** →
  inspect authoritative evidence and make an agent-owned semantic decision.
  Escalate only when the disagreement meets the workflow definition of absolute
  disagreement: use one consolidated user checkpoint in `default`, or
  `BLOCKED_HANDOFF` in `auto`.
- **Several fundamental blockers show that the issue is not close to
  agent-ready** → stop incremental patching. In `default`, return to Phase 1 for
  a structural re-draft with the user's agreement. In `auto`, do not reset the
  review budget automatically; return a consolidated `BLOCKED_HANDOFF`.

Never start a fourth unrestricted Phase 2 review. The maximum-round rule is a
convergence and escalation boundary, not an automatic pass.

The three-review budget belongs to the current issue-contract revision cycle. A
relay finding, deterministic correction, or selection of `auto` never resets
it. Only a user-requested or user-authorized material contract change may start
a new cycle; record the reason, carry the prior finding ledger forward, and
restart the count explicitly. Editorial changes that do not alter contract
semantics do not start a new review cycle.

## Phase 3 — Mode-aware publication checkpoint

### `default`

Present the exact reviewed or deterministically corrected issue body, its review
status, and any remaining risks to the user.

- **Approved** → create the issue or update the placeholder using a body file,
  preserving repository metadata outside the authorized scope.
- **Requests editorial changes** → apply them, verify that contract semantics did
  not change, and present the exact body again without resetting the review
  budget.
- **Requests a material contract change** → record a new user-authorized
  revision cycle and return to the appropriate Phase 1 or Phase 2 step.
- **Aborted** → stop and leave the refinement draft, finding ledger, and decision
  record available to the user.

### `auto`

Do not create a routine exact-body approval checkpoint. Create or update the
issue using a body file and continue when all of these are true:

- No `user-decision`, authority blocker, or absolute disagreement remains.
- No agent-verified admissible contract blocker remains.
- The final body stays within the user's stated product intent and authorized
  scope.
- Every deterministic post-review correction and remaining risk is recorded.

If any condition fails, do not publish a materially changed issue body. Complete
independent safe work and end with one consolidated `BLOCKED_HANDOFF`.

After creating or updating the issue:

1. Read the remote issue back.
2. Verify the rendered body, links, checklists, issue type, milestone, and other fields that were intentionally changed.
3. Correct publishing or formatting mistakes without changing the approved or pre-authorized contract.

Do not publish or materially update an issue body without either exact approval
in `default` or the explicit pre-authorization and successful gates required by
`auto`.

## Phase 4 — Continue through the shared implementation workflow

The remote issue is now the authoritative agent-ready contract.

Continue at Phase 1 of [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md), with these invariants:

- Reuse the same task-specific relay session.
- Preserve the selected execution mode.
- Pass the final remote issue URL, not an obsolete local draft.
- Do not repeat decision-point discovery or issue refinement.
- Preserve the user's approved or pre-authorized scope and acceptance criteria.
- Continue autonomously unless the downstream workflow identifies a genuine missing product decision or another explicit stop condition.

---

## Global rules

- **Never let agent-relay convergence substitute for user product authority.**
- **Publish an issue contract only after exact-body approval in `default`, or after every pre-authorized publication gate passes in `auto`.**
- **Never silently expand scope while resolving review feedback.**
- **Phase 2 permits at most three full issue-body review submissions; after the final contract-convergence review, proceed to the selected mode's checkpoint, make a deterministic verified correction, or escalate—never restart unrestricted review.**
- **`auto` changes checkpoint behavior, not finding admissibility, review budgets, or quality gates; never ask relay separately whether auto execution may continue.**
- **Batch unresolved user-owned decisions into one checkpoint in `default` or one `BLOCKED_HANDOFF` in `auto`.**
- **Use the same user-supplied, task-specific relay session across refinement, implementation-plan review, and PR review.**
- **If relay pauses or hits a captcha:** do not retry automatically; complete independent safe work, then use one consolidated checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`.
- **If the issue is already agent-ready:** route directly to the shared workflow instead of performing ceremonial refinement.
- **Downstream draft PR, CI, review-thread, ready-for-review, and merge rules are owned by `agent-ready-issue-to-pr.md`.**
