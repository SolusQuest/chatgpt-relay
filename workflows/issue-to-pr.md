# Workflow: Rough issue → agent-ready issue → implementation → PR

**References**:

- Relay agent usage patterns: [`agent-instructions.md`](../agent-instructions.md)
- Shared implementation and PR workflow: [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md)

---

## What this workflow is

This workflow turns a placeholder or under-specified GitHub issue into an agent-ready issue, then continues through the shared implementation workflow.

Its responsibility is refinement: discover the material decisions, turn them into an explicit issue contract, obtain user approval, and publish the approved issue. It does not maintain a second copy of implementation, CI, PR-review, or handoff rules; after refinement it delegates those phases to [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md).

Use this slower path when getting scope and acceptance criteria wrong would be more expensive than discussing them first.

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

Use at most three discussion rounds after the independent outputs. If a substantive disagreement remains, present both rationales to the user for a decision.

Any product, policy, UX, public-contract, or scope trade-off belongs to the user. Relay and the agent may clarify the trade-off but must not silently decide it.

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

Do not leave unresolved product decisions disguised as “open questions.” If a user decision is still required, return to Phase 1's user checkpoint.

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
- `late-finding` — discoverable earlier and not caused by the latest revision;
- `out-of-scope` — requires adding behavior outside the proposed scope;
- `user-decision` — exposes a product, policy, UX, public-contract, or scope
  trade-off that the agent cannot settle.

Only an unresolved prior blocker, a `revision-regression`, or a
`new-evidence` finding can normally continue to block contract convergence. A
`late-finding` does not become blocking merely because it was labeled a blocker;
the agent must verify its concrete impact. Record `out-of-scope` findings as
excluded or deferred. Route `user-decision` findings to the user.

Evaluate the response semantically:

- Real contract gap → revise the draft and request another review only while the three-submission budget remains.
- Missing user decision → present the concrete choice to the user.
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
- classification: carried, revision-regression, new-evidence, or user-decision;
- the exact issue section, repository contract, template rule, dependency, or
  authoritative source;
- the concrete implementation ambiguity or failure that would result;
- why this blocks an agent-ready contract rather than being optional scope,
  wording polish, style preference, or follow-up work;
- the minimum required correction or user decision.

Do not classify a late finding as blocking unless it is supported by new
evidence or was directly introduced by the latest revision.

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
  present the exact issue body at the Phase 3 user-approval checkpoint.
- **A real blocker has a deterministic, contract-local correction** → make the
  minimum correction, verify that every acceptance criterion remains
  implementable and testable, record it in the ledger, and present the exact
  corrected body to the user without another unrestricted relay review.
- **A blocker requires a product, policy, UX, public-contract, or scope
  decision** → return to the Phase 1 user checkpoint with the concrete choice
  and competing rationales.
- **Agent and relay still disagree about a repository fact or blocker severity**
  → present the authoritative evidence, impact, and competing rationale to the
  user rather than starting a fourth review.
- **Several fundamental blockers show that the issue is not close to
  agent-ready** → stop incremental patching and return to Phase 1 for a
  structural re-draft.

Never start a fourth unrestricted Phase 2 review. The maximum-round rule is a
convergence and escalation boundary, not an automatic pass, and it never
replaces the Phase 3 user-approval requirement.

## Phase 3 — User approval and remote publication

Present the exact reviewed issue body to the user.

- **Approved** → create the issue or update the placeholder using a body file, preserving repository metadata outside the authorized scope.
- **Requests changes** → revise the local draft and return to Phase 2 review.
- **Aborted** → stop and leave the refinement draft and decision record available to the user.

After creating or updating the issue:

1. Read the remote issue back.
2. Verify the rendered body, links, checklists, issue type, milestone, and other fields that were intentionally changed.
3. Correct publishing or formatting mistakes without changing the approved contract.

Do not publish or materially update an issue body before user approval.

## Phase 4 — Continue through the shared implementation workflow

The remote issue is now the authoritative agent-ready contract.

Continue at Phase 1 of [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md), with these invariants:

- Reuse the same task-specific relay session.
- Pass the final remote issue URL, not an obsolete local draft.
- Do not repeat decision-point discovery or issue refinement.
- Preserve the user's approved scope and acceptance criteria.
- Continue autonomously unless the downstream workflow identifies a genuine missing product decision or another explicit stop condition.

---

## Global rules

- **Never let agent-relay convergence substitute for user product authority.**
- **Never publish an issue contract before the user approves its exact body.**
- **Never silently expand scope while resolving review feedback.**
- **Phase 2 permits at most three full issue-body review submissions; after the final contract-convergence review, present the exact body, make a deterministic verified correction, or escalate—never restart unrestricted review.**
- **Use the same user-supplied, task-specific relay session across refinement, implementation-plan review, and PR review.**
- **If relay pauses or hits a captcha:** stop, tell the user, and do not retry automatically.
- **If the issue is already agent-ready:** route directly to the shared workflow instead of performing ceremonial refinement.
- **Downstream draft PR, CI, review-thread, ready-for-review, and merge rules are owned by `agent-ready-issue-to-pr.md`.**
