# Workflow: Agent-ready issue → reviewed plan → implementation → draft PR

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes and session selection: [execution modes](./README.md#execution-modes) and [session selection](./README.md#relay-session-selection)
- Stage handoffs and reference loading: [stage handoffs and delegation](./README.md#stage-handoffs-and-delegation)
- Review protocol: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`plan.md`](./plan.md) and [`implementation.md`](./implementation.md): when running or delegating the respective stage; load each stage's procedure when it becomes active.
- [`issue-to-pr.md`](./issue-to-pr.md): when routing an initially rough issue to the full refinement composition.
- [`design.md`](./design.md): when taking Plan's authorized readiness fallback; run the Design stage without invoking the rough-issue composition.

## Purpose and routing

Use this composition when the issue is a frozen implementation contract with settled product decisions, explicit scope and non-goals, testable acceptance criteria, and declared dependency handling. It runs the reviewed implementation/test plan, code, tests, validation, a remote draft PR, integrated CI/GitHub/relay convergence, initial exact-gate ready-for-review promotion, and user handoff. The linked stages own the existing rules.

Use [`issue-to-pr.md`](./issue-to-pr.md) when material product, scope, or acceptance questions remain. Do not use this composition for exploratory work, trivial edits whose review overhead exceeds risk, or when the user explicitly declines relay.

`default` preserves explicit checkpoints; `auto` continues without routine intervention to `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF`. Both modes use identical quality gates.

## Preconditions

- The authoritative issue is available by URL or complete text.
- Repository instructions, design contracts, and declared dependencies are accessible.
- Resolve the task-specific session at invocation preflight using the shared [session-selection rule](./README.md#relay-session-selection). Relay must be reachable and the selected or newly created session usable before each required submission.
- The user authorized implementation, branch publication, a draft PR, relay review, and the final gate's initial draft-to-ready transition.
- Record or inherit the execution mode and [handoff record](./README.md#stage-handoffs-and-delegation); pin the same mode and session through plan and PR review.

## Composed execution

1. Run [Plan](./plan.md) through readiness, implementation/test planning, and bounded plan review. Its standard and independent-discovery paths, contract-applicability challenges, checkpoints, and remaining budgets apply. Consume `PLAN_READY` with the complete reviewed or deterministically corrected plan.
2. Run [Implementation](./implementation.md) with that handoff through code/tests, local validation, remote draft PR publication, integrated CI/GitHub/relay convergence, exact-head readiness, and final handoff. Do not repeat plan discovery or review solely because the implementing agent differs.
3. Return `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` with Implementation's required report. `PLAN_READY` is an intermediate handoff, not a routine user checkpoint or the terminal result of this composition.

Stages may be assigned to different agents under the shared [delegation rules](./README.md#stage-handoffs-and-delegation). Preserve task identity, authority, artifacts, review history, and remaining budgets through every boundary. On resume, use the existing applicable handoff rather than repeating completed stages. New evidence, contract changes, or implementation deviations follow the stage-owned continuation rules and never reset review automatically.

## Automatic readiness fallback

Before implementation starts, `auto` may take Plan's one-time [automatic readiness fallback](./plan.md#automatic-readiness-fallback) when its existing conditions hold. Run only [Design](./design.md) starting at Phase 1 through contract review, mode-aware publication, and remote readback to `DESIGN_READY`; preserve the fallback-used record, then return to Plan with that handoff, the refined authoritative issue, and remaining applicable review budget. If Design is blocked, follow its blocked outcome instead of continuing Plan. Do not invoke the full `issue-to-pr` composition or automatically take fallback again.

## Review submission and CI scheduling

[Implementation owns the review submission and CI scheduling policy](./implementation.md#review-submission-and-ci-scheduling): CI, GitHub feedback observation, and Relay review default to parallel after required pre-review proof, with evidence-based waiting for named checks or full CI and holds for known defects or missing mandatory proof. The final [exact-head readiness gate](./implementation.md#final-readiness-gate) still requires all required CI, execution proof, acceptance coverage, feedback dispositions, Relay continuation, promotion, and remote readback.

## Post-handoff PR feedback re-entry

Follow [Implementation's post-handoff re-entry rules](./implementation.md#post-handoff-pr-feedback-re-entry) only when the user requests handling a later feedback batch. Preserve the existing PR ready state, task-specific session, ledger, cutoffs, and applicable review cycles; do not rerun Design or Plan merely because the PR is resumed. The user owns human review, merge, later ready/draft changes, and whether re-entry occurs.
