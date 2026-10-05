# Workflow: Rough issue → agent-ready issue → implementation → PR

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes and session selection: [execution modes](./README.md#execution-modes) and [session selection](./README.md#relay-session-selection)
- Stage handoffs and reference loading: [stage handoffs and delegation](./README.md#stage-handoffs-and-delegation)
- Review protocol: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`design.md`](./design.md): when running or delegating Design.
- [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): when continuing with its Plan → Implementation composition or routing an already-frozen issue directly to that entry. Read its stage documents as each becomes active or is delegated.

## Purpose and routing

Use this composition to turn a placeholder, rough draft, or ambiguous problem report into an explicit issue contract, publish it through the selected checkpoint, and continue through the reviewed plan, implementation, and PR handoff. It preserves the full issue-to-PR process; the linked stages own its existing rules.

Use [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) directly when scope, non-goals, acceptance criteria, dependencies, and product decisions are already settled. Do not use either composition for trivial edits, exploratory learning without an implementation contract, or when the user explicitly declines refinement or relay. Route from the actual issue and repository context, not labels.

## Preconditions

- The full issue is available by URL or complete text.
- Repository instructions and relevant product, architecture, and contract sources are accessible.
- Resolve the task-specific session at invocation preflight using the shared [session-selection rule](./README.md#relay-session-selection). Relay must be reachable and the selected or newly created session usable before each required submission.
- The user authorized refinement, publication under the selected mode, implementation, branch publication, a draft PR, relay review, and the final gate's initial draft-to-ready transition.
- Record `default` when no mode is specified; pin the session and mode through the composition, inheriting any existing [handoff record](./README.md#stage-handoffs-and-delegation).

## Composed execution

1. Run [Design](./design.md) through decision discovery, contract review, mode-aware publication, and remote issue readback. The existing `default` exact-body approval checkpoint and `auto` publication conditions apply. Consume its `DESIGN_READY` handoff and authoritative remote issue.
2. Continue through [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): run [Plan](./plan.md), consume `PLAN_READY`, then run [Implementation](./implementation.md) through its final gate and PR handoff. Do not repeat refinement or add routine approval checkpoints at stage boundaries.
3. Return the existing final `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` with Implementation's required report. Intermediate stage statuses do not terminate this full composition when authorized continuation is possible.

Stages may be assigned to different agents under the shared [delegation rules](./README.md#stage-handoffs-and-delegation). Preserve the same repository/issue, workspace/worktree and branch if selected, mode, task-specific Relay session, authority, project constraint profile, artifact revisions, finding ledger, evidence, consumed review rounds, and fallback-used record. A stage or agent change does not reset review, expand authority, or repeat completed work.

The one-time [automatic readiness fallback](./plan.md#automatic-readiness-fallback) runs only Design from Phase 1 through `DESIGN_READY`, then returns to the existing Plan stage with its remaining budget; it does not restart this composition. If Design is blocked, follow its blocked outcome instead of continuing Plan. On resume, continue from the recorded applicable stage rather than starting discovery again. For user-authorized post-handoff PR feedback, follow [Implementation's re-entry rules](./implementation.md#post-handoff-pr-feedback-re-entry).

Never let agent-relay agreement replace user product authority, silently expand scope, retry relay automatically after pause/captcha, or duplicate stage-owned review and PR rules here.
