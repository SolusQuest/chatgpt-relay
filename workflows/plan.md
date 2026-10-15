# Workflow: Plan

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Effort defaults, fallback and inheritance: [Relay effort policy](./README.md#relay-effort-policy)
- [Execution modes](./README.md#execution-modes), [session selection](./README.md#relay-session-selection), and [stage handoffs/reference loading](./README.md#stage-handoffs-and-delegation)
- Review protocol and prompt base: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`design.md`](./design.md): routing to refinement or authorized fallback; consuming its handoff needs no procedure reread.
- [`implementation.md`](./implementation.md): selecting/invoking Implementation; standalone Plan does not preload it.
- [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): coordinating that composition; delegated Plan inherits invocation/authority in its handoff.

## Purpose and routing

Map a frozen issue's settled decisions, scope/non-goals, testable acceptance, and dependencies onto the repository, then review the implementation/test plan. Material unresolved decisions belong to [Design](./design.md), subject to the [one-time fallback](#automatic-readiness-fallback). Exclude exploratory work, trivial edits whose review overhead exceeds risk, and work where the user declines Relay.

Standalone Plan ends at `PLAN_READY` or `BLOCKED_HANDOFF`. Composition continues without another approval gate. `PLAN_READY` reports reviewed/verified planning, granting neither implementation/publication authority nor PR readiness.

## Preconditions

- Authoritative issue URL/text and any existing Design handoff; already-ready issues require no new Design or `DESIGN_READY` record.
- Accessible instructions, design contracts, implementation, nearby tests, and dependencies.
- Authority for investigation, planning, and Relay review; fallback refinement/publication follows its conditions below.
- Resolve/inherit mode, session, and shared handoff; require a usable session per submission and preserve task identity, ledger, and budgets.

## Phase 1 — Readiness and implementation/test plan

Read complete issue, instructions/contracts, implementation, and nearby tests. Classify readiness without rewriting the issue: scope/non-goals, testable acceptance, settled product/public-contract decisions, usable dependencies. Verify or derive the shared [constraint profile](./review-convergence.md#applicability-and-proportionality) from current evidence and use it through plan/PR review; neither a maturity label nor generic practice creates release-grade requirements.

For a disproportionate frozen requirement that cannot reasonably take a narrower interpretation, record one evidenced contract-applicability challenge before implementation: consolidated checkpoint in `default`, `BLOCKED_HANDOFF` in `auto`. A Relay preference outside the contract does not trigger that checkpoint.

Readiness failure records the complete missing-decision set. In `default`, recommend Design at one checkpoint. In `auto`, use eligible fallback; otherwise complete independent safe analysis and return `BLOCKED_HANDOFF`.

### Automatic readiness fallback

In `auto`, once per issue execution chain, run only [Design](./design.md) from Phase 1 through contract review, publication, remote readback, and `DESIGN_READY`, then return here. Never invoke the full `issue-to-pr` composition. All conditions must hold:

- Implementation has not started; Phase 1/2 would otherwise block because the issue is incomplete, acceptance ambiguous, or refinement required.
- Refinement/publication fit stated intent and scope. This fallback authorizes normal in-scope refinement/publication under Design's `auto` gates unless explicitly excluded; it delegates no new product/contract decision.
- No authority blocker/absolute disagreement; sources, dependencies, and Relay are available. Missing authority, unmet external dependencies, and Relay failures are not fallback triggers.
- Fallback is unused and required reviews fit existing remaining budgets. Exhaustion alone is not a trigger.

Before switching, record origin phase, readiness blockers, authority, and usage. Carry the same repository/issue, selected workspace/branch, mode/session, profile, ledger, evidence, and consumed rounds through Design and back; delegation/resume never clears them. Design's bounded discovery/contract review supplies no extra plan-review rounds.

After `DESIGN_READY`, return to Phase 1 with the authoritative refined issue, reconcile the existing plan/ledger, and spend only remaining plan rounds. Refinement grants no fresh plan or exhausted contract cycle and weakens no gate. Blocked Design or returned Plan produces one consolidated blocked handoff; no automatic second fallback. Fallback is unavailable once implementation starts.

### Plan creation

Use the **standard path** for established patterns with an obvious low-risk route: inspect and draft before review. Use **parallel independent discovery** for public API/schema/persisted-format/migration/compatibility changes; security/privacy/concurrency/recovery/state consistency; multiple repositories/owners; materially different approaches; or other high rework risk.

Independent discovery submits facts before agent opinions and persists the complete agent plan before reading Relay. Verify/synthesize blind spots into one agent-owned plan; user decisions take the mode's checkpoint/blocked outcome.

The visible plan covers affected components/files, implementation order/choices, every acceptance criterion mapped to production behavior/tests, applicable happy/boundary/failure/regression/concurrency/state-transition cases, evidence-based compatibility/migration/security/privacy/performance/operations, focused/full validation including CI-only/manual proof, and risks/assumptions. Keep it sufficient to expose a wrong path, not a second issue body.

## Phase 2 — Plan review

Mandatory for non-trivial work in either creation path, without routine user approval. Prepend the shared [prompt base](./review-convergence.md#review-prompt-assembly) as actual text to both prompts. The second submission includes current complete plan, ledger, revision summary, and verified repository evidence.

### Initial review

```text
Act as a strict implementation/test-plan reviewer. Product scope and acceptance
are frozen. Return all currently identifiable blockers in acceptance coverage,
repository boundaries/contracts, compatibility/migration, failure paths,
security/performance/operations, tests, validation, and ordering. Cite the exact
criterion/source and concrete implementation failure. Separate implementation-
local detail from blockers and state whether implementation may begin.

Issue: <url>
Project constraint profile: <evidence and unknowns>
Implementation/test plan: <complete text>
```

Apply shared applicability/ledger rules. A `critical-late-finding` requires the exact criterion, path, contract, or source; concrete failure; and why correction must precede implementation. Record non-blocking/out-of-scope work without changing the frozen issue.

### Third submission — final plan convergence

```text
This is final implementation/test-plan convergence. The issue is frozen: do not
restart design/full review, reopen resolved findings without evidence, or add
optional scope. Review only unresolved findings, blocker regressions, new
authoritative evidence, and proven critical late findings. Give each blocker's
ID/classification, exact source, implementation failure, and why it blocks.

Return exactly one verdict:
- READY: no admissible implementation blocker remains.
- CORRECT: only deterministic implementation-local corrections remain.
- ESCALATE: a product decision, material trade-off, or fundamental re-plan is required.
Do not request another full review.

Issue: <url>
Project constraint profile: <evidence and unknowns>
Finding ledger: <complete ledger>
Revision summary: <changes since previous round>
Implementation/test plan: <complete text>
```

Apply shared continuation: `READY` permits handoff; `CORRECT` requires verified minimum correction/ledger update and downstream tests/PR review of that area. Implementation still requires its separate authority. Undelegated product/public-contract/compatibility/migration/security/privacy decisions or absolute disagreement take the selected mode's checkpoint/blocked outcome.

Fundamental re-plan/unready issue gets one return-to-planning recommendation in `default`. In `auto`, only eligible one-time fallback applies; otherwise return `BLOCKED_HANDOFF`. Re-plan alone authorizes neither fallback nor budget reset. Only explicit user-authorized material issue or engineering-risk-boundary change starts another full plan cycle; retain ledger/reason.

## Phase 3 — Stage handoff

Return `PLAN_READY` only after readiness/review continuation permits implementation, required deterministic corrections are verified, and no admissible blocker remains. Persist the shared [handoff](./README.md#stage-handoffs-and-delegation): complete current plan/revision, authoritative issue revision, repository/working-tree baseline, acceptance/test mapping, validation, assumptions, review task IDs/verdicts/decision, non-blocking risks, ledger, established remaining budgets, and fallback usage. Flag corrected areas for downstream test/PR coverage.

Standalone use stops; composition returns to Implementation under existing authority with the same session/mode/scope. Agent changes do not repeat discovery/review or add a checkpoint. Blocked outcomes preserve plan, missing decisions, ledger/budgets, fallback record, and evidence; delegation/resume authorizes no cycle reset or second fallback.
