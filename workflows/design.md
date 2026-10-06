# Workflow: Design

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- [Execution modes](./README.md#execution-modes), [session selection](./README.md#relay-session-selection), and [stage handoffs/reference loading](./README.md#stage-handoffs-and-delegation)
- Review protocol and prompt base: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`plan.md`](./plan.md): selecting/invoking Plan; a standalone handoff requires no downstream procedure.
- [`issue-to-pr.md`](./issue-to-pr.md): coordinating the full composition; delegated Design inherits invocation/authority through its handoff.

## Purpose and routing

Turn a rough or ambiguous issue into a reviewed, published agent-ready contract. Design owns decision discovery and refinement; it adds no architecture document or review gate. Route settled issues to [Plan](./plan.md) from actual repository/issue context, not labels. Exclude trivial edits, exploration without an implementation contract, and work where the user declines refinement or Relay.

Standalone Design ends at `DESIGN_READY` or `BLOCKED_HANDOFF`. Compositions continue authorized stages without another checkpoint. `DESIGN_READY` requires publication/readback and grants neither implementation authority nor PR readiness.

## Preconditions

- Complete issue URL/text and accessible repository instructions, product, architecture, and contract sources.
- Authority for refinement, mode-aware publication, and Relay review.
- Resolve/inherit mode, task-specific session, and shared handoff; require a usable session before each submission. Preserve established contract cycles, ledgers, plan budgets, and fallback usage.

## Phase 1 — Independent decision discovery

Use `agent-instructions.md`'s independent-discussion barriers:

1. Submit facts/issue URL first, asking Relay for blocking decisions and relevant project-stage facts.
2. Inspect the repository and persist the agent's own decision list and evidence-based [constraint profile](./review-convergence.md#applicability-and-proportionality) before reading the reply.
3. Compare shared, agent-only, Relay-only, and conflicting points; verify repository claims and discuss material gaps.

Cover scope/non-goals, testable acceptance, public contracts/compatibility, migration/rollout, failure/operations, security/privacy/performance, dependencies/sequencing, and relevant naming. The profile is a concise evidence summary of dimensions affecting this contract, not a new design document or a reason to add unsupported release-grade machinery.

Stop when drafting has no blocking decision, another round adds no substance, or only wording/optional follow-ups remain. Allow at most three discussion follow-ups, including in `auto`.

Undelegated product, policy, UX, public-contract, and scope trade-offs remain user-owned. Batch unresolved decisions/disagreements into one `default` checkpoint. In `auto`, resolve facts and deterministic in-scope choices from evidence, then return one `BLOCKED_HANDOFF` for remaining authority blockers or absolute disagreement.

## Phase 2 — Draft and review the issue contract

Create a visible local draft from the target repository's issue template: problem/motivation; scope/exclusions/non-goals; concrete testable acceptance; dependencies/sequencing; evidence-based lifecycle/compatibility posture and currently applicable migration/security/operations; risks/deferred work; resolved implementation decisions. Required user decisions must take Phase 1's outcome, never hide under “open questions.”

For both prompts below, prepend the shared [review prompt base](./review-convergence.md#review-prompt-assembly) as actual text. The second submission includes the complete current body, ledger, and revision summary.

### Initial review

```text
Act as a strict product and engineering reviewer of this refined issue.
Return all currently identifiable blockers in scope, non-goals, executable
acceptance, dependencies, risks, compatibility, and unresolved decisions.
Cite the issue section or authoritative source and explain the implementation
ambiguity/failure. State when the issue is agent-ready.

Issue or placeholder: <url if available>
Project constraint profile: <evidence and unknowns>
Refined issue draft: <complete text>
```

Use shared budgets, applicability, and finding lineage. A `critical-late-finding` requires its exact section/source, resulting ambiguity/failure, affected acceptance or contract boundary, and why this issue must resolve it. `user-decision` identifies an unauthorized material trade-off; record other non-blocking work as exclusions, deferred work, or risk. Challenge materially disproportionate frozen requirements through the shared contract-applicability rule.

### Third submission — final contract convergence

```text
This is final contract convergence. Do not restart discovery or full review,
reopen resolved findings without evidence, or add optional scope. Review only
unresolved findings, blocker regressions, new authoritative evidence, and proven
critical late findings. Cite each blocker's exact section/source and affected
acceptance criterion or contract boundary; explain why it prevents an agent-ready
contract, retain its ID/classification, and give the correction or user decision.

Return exactly one verdict:
- READY: no admissible contract blocker remains.
- CORRECT: only deterministic contract-local corrections remain.
- ESCALATE: a user-owned decision or fundamental re-draft is required.
Do not request another full review.

Issue or placeholder: <url if available>
Project constraint profile: <evidence and unknowns>
Finding ledger: <complete ledger>
Revision summary: <changes since previous round>
Refined issue draft: <complete text>
```

Apply shared continuation: `READY` proceeds; `CORRECT` permits minimum verified contract-local corrections and ledger update without unrestricted re-review. User decisions/absolute disagreement take one `default` checkpoint or `auto` blocked handoff. Fundamental re-draft requires user agreement in `default` and no automatic reset in `auto`.

Only a user-requested/authorized material contract change starts a new contract cycle; retain ledger/reason. Editorial changes do not reset it.

## Phase 3 — Mode-aware publication

### `default`

Present the exact reviewed or verified corrected body, review status, and risks. Approval permits body-file publication while preserving unrelated metadata. Editorial requests require semantic verification and exact-body presentation again; material requests record an authorized new cycle and return to Phase 1/2. Abort preserves draft, ledger, and decision record.

### `auto`

Publish with a body file without routine approval only when scope/intent/authority hold, no user decision, authority blocker, absolute disagreement, or verified contract blocker remains, and post-review corrections/risks are recorded. Otherwise return one `BLOCKED_HANDOFF` without publishing the material change.

Read back the remote body, links, checklists, issue type, milestone, and intentionally changed fields. Correct publication errors without changing the approved/pre-authorized contract.

## Phase 4 — Stage handoff

The read-back remote issue becomes authoritative. Return `DESIGN_READY` only after review/continuation, mode-aware publication, and verification pass. Persist the shared [handoff](./README.md#stage-handoffs-and-delegation), including exact published revision, decisions/profile, review/correction evidence, continuation, ledger/budgets, risks, and deferred work.

When entered through Plan's [fallback](./plan.md#automatic-readiness-fallback), return its origin/phase, fallback-used record, repository/issue/workspace/branch, existing plan, all budgets, and evidence to the original Plan stage. Use remaining budgets; no new plan cycle or automatic second fallback.

Standalone use stops here; composition returns to its authorized caller with the same session/mode/scope, without repeated refinement or restarting `issue-to-pr`. Blocked outcomes preserve draft, ledger, budgets, and evidence under the shared mode rules.
