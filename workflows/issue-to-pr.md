# Workflow: Rough issue → agent-ready issue → implementation → PR

**References**:

- Relay API + usage patterns: [`agent-instructions.md`](../agent-instructions.md)
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
请作为严格的 PM/工程 reviewer 审查下面的 refined issue body。

重点检查 scope、non-goals、AC 的可执行性、依赖与风险、兼容性，以及是否仍有会阻塞
实现的含糊决策。按严重程度列出问题；如果没有阻塞问题，请明确说明它已 agent-ready。

Issue or placeholder: <url if available>

--- refined issue draft ---
<完整 draft>
```

Evaluate the response semantically:

- Real contract gap → revise the draft and request another review.
- Missing user decision → present the concrete choice to the user.
- Scope expansion or optional follow-up → record it as excluded or deferred.
- Style-only preference → adopt only when it improves the repository's issue contract.

Terminate when relay finds no blocking issue and the agent independently confirms that every acceptance criterion is implementable and testable.

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
- **Use the same user-supplied, task-specific relay session across refinement, implementation-plan review, and PR review.**
- **If relay pauses or hits a captcha:** stop, tell the user, and do not retry automatically.
- **If the issue is already agent-ready:** route directly to the shared workflow instead of performing ceremonial refinement.
- **Downstream draft PR, CI, review-thread, ready-for-review, and merge rules are owned by `agent-ready-issue-to-pr.md`.**
