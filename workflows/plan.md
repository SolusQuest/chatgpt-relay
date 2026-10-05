# Workflow: Plan

**Required shared rules**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes and session selection: [execution modes](./README.md#execution-modes) and [session selection](./README.md#relay-session-selection)
- Stage handoffs and reference loading: [stage handoffs and delegation](./README.md#stage-handoffs-and-delegation)
- Review protocol: [`review-convergence.md`](./review-convergence.md)

**Boundary references — read only when applicable**:

- [`design.md`](./design.md): when routing to refinement or taking the authorized readiness fallback. Consuming an existing Design handoff does not require rereading Design's procedure.
- [`implementation.md`](./implementation.md): when selecting or invoking Implementation. Producing a standalone `PLAN_READY` handoff does not require reading the downstream stage.
- [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md): when coordinating that full composition. A delegated Plan agent inherits its invocation context and authority through the handoff.

## Purpose and routing

Use this stage when the issue is a frozen implementation contract with settled product decisions, explicit scope and non-goals, testable acceptance criteria, and declared dependency handling. Map that contract onto the current repository and review the implementation/test plan.

Use [`design.md`](./design.md) when material product, scope, or acceptance questions remain, subject to the one-time [readiness fallback](#automatic-readiness-fallback). Do not use this stage for exploratory work, trivial edits whose review overhead exceeds risk, or when the user explicitly declines relay.

A standalone invocation ends at `PLAN_READY` or `BLOCKED_HANDOFF`. A composing workflow consumes `PLAN_READY` and continues implementation without adding a user approval gate. `PLAN_READY` reports a reviewed or deterministically corrected plan under the shared continuation protocol; it is not a PR readiness verdict or implementation/publication authority.

## Preconditions

- The authoritative issue is available by URL or complete text; inherit a Design handoff when one exists. An issue already agent-ready does not require a new Design stage or `DESIGN_READY` record.
- Repository instructions, design contracts, current implementation, nearby tests, and declared dependencies are accessible.
- The user authorized repository investigation, implementation/test planning, and relay review. Any automatic refinement/publication must separately satisfy the fallback's existing authority conditions.
- Resolve or inherit the task-specific session using the shared [session-selection rule](./README.md#relay-session-selection), and require it to be usable before each submission.
- Record or inherit the execution mode and [stage handoff](./README.md#stage-handoffs-and-delegation); pin the same task identity, ledger, and stage budgets throughout.

## Phase 1 — Readiness and implementation/test plan

Read the complete issue, repository instructions, relevant contracts, current implementation, and nearby tests. Confirm explicit scope/non-goals, testable acceptance criteria, no unresolved product or public-contract decision, and usable dependency handling. This is classification, not refinement.

Verify or derive the issue's concise project constraint profile from current evidence, recording only dimensions that can change the implementation decision: release state and milestone purpose; real or committed near-term consumers and deployments; persisted production data or long-lived artifacts; compatibility/versioning commitments; reversibility and failure cost; and security, privacy, or regulatory boundaries. Use it throughout plan and PR review. Do not infer release-grade requirements from a maturity label or generic best practice.

If an explicit frozen requirement appears materially disproportionate and cannot reasonably be satisfied by a narrower interpretation, record one contract-applicability challenge with evidence. Do not silently ignore it or spend implementation effort before resolving the contract: use one consolidated checkpoint in `default`, or return `BLOCKED_HANDOFF` in `auto`. A relay preference that is not part of the frozen contract does not trigger this checkpoint.

If readiness fails, record the complete missing-decision set. In `default`, recommend `design.md` at one checkpoint. In `auto`, apply the automatic readiness fallback below; if it is ineligible, complete independent safe analysis and return `BLOCKED_HANDOFF`. Do not rewrite the frozen issue inside this Plan stage.

### Automatic readiness fallback

In `auto`, run [`design.md`](./design.md) starting at Phase 1 and continuing through contract review, mode-aware publication, and remote readback to `DESIGN_READY`, once per issue execution chain when all of these conditions hold. Invoke only the Design stage and return here only after its `DESIGN_READY` handoff; do not invoke `issue-to-pr.md` and accidentally restart the full composition:

- Implementation has not started, and Phase 1 or Phase 2 would otherwise end at `BLOCKED_HANDOFF` because the issue contract is incomplete, acceptance criteria are ambiguous, or further issue refinement is required.
- Refinement and issue publication remain within the user's stated intent and authorized scope. This fallback authorizes normal in-scope refinement and publication under `design.md`'s `auto` gates, unless the user explicitly excluded them; it does not delegate new product or contract decisions.
- No unresolved authority blocker or absolute disagreement remains, and required sources, dependencies, and Relay are available. Missing authorization, unmet external dependencies, and Relay execution failures are not fallback triggers.
- This execution chain has not already used the fallback, and the required remaining reviews can fit within the existing applicable budgets. Budget exhaustion alone is not a fallback trigger.

Before switching, record the originating phase, readiness blockers, authority basis, and fallback usage. Preserve the same repository and issue, workspace/worktree and branch if already selected, `auto` mode, task-specific Relay session, project constraint profile, finding ledger, evidence, and consumed review rounds. Carry this record through Design and the return to Plan; a stage invocation, composition, delegation, or resume does not clear it.

Use Design's own bounded discovery and contract-review stages; do not use them as extra implementation-plan reviews. After remote issue publication and readback, return to Phase 1 here with the refined authoritative issue, reconcile the existing plan and ledger, and use only the remaining plan-review rounds. The switch or resulting refinement does not itself authorize a fresh plan cycle, an exhausted contract-review cycle, or weaker validation gates.

If Design or the returned Plan stage remains blocked, return one consolidated `BLOCKED_HANDOFF` under the applicable stage rules. Do not switch back to refinement again automatically. Once implementation has started, this fallback is unavailable.

### Plan creation

Use the **standard path** when the change follows established repository patterns and has a largely obvious, low-risk implementation route. The agent inspects the repository and writes the plan before Phase 2 review.

Use **parallel independent discovery** when the change affects a public API/schema/persisted format/migration/compatibility boundary; security, privacy, concurrency, recovery, or state consistency; multiple repositories or owners; materially different viable approaches; or another high-rework-risk path.

For parallel discovery, use the barriers from `agent-instructions.md`: submit a context-only relay task before writing agent opinions, persist the complete agent plan before reading relay, then verify and synthesize relay-only blind spots into one agent-owned plan. A genuine product decision uses one checkpoint in `default` or `BLOCKED_HANDOFF` in `auto`.

The resulting visible plan contains:

1. Affected components and expected files.
2. Implementation order and key engineering choices.
3. Every acceptance criterion mapped to production behavior and tests.
4. Happy, boundary, failure, regression, concurrency, and state-transition coverage as applicable.
5. The applicable compatibility, migration, security, privacy, performance, and operational measures, with evidence and the minimum sufficient approach.
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

Evaluate applicability before severity. A general best practice is a blocker
only when required by the frozen issue or repository policy, or omission causes
a concrete current failure for a real consumer, persisted artifact, security
boundary, or release commitment. State that basis, affected exposure, failure,
why this plan must address it now, and why a simpler reversible measure is
insufficient.

Also identify planned release-grade versioning, migration, compatibility,
deprecation, or operational complexity that lacks current evidence; recommend
the minimum sufficient alternative. Project maturity is evidence, not a blanket
exemption.

Separate blockers from implementation-local detail, optional hardening, style,
and follow-up work. State explicitly when implementation may begin.

Issue: <url>

--- project constraint profile ---
<evidence and unknowns>

--- implementation/test plan ---
<complete plan>
```

Apply the three-round budget and stable ledger from `review-convergence.md`. A plan `critical-late-finding` must identify the exact criterion, code path, contract, or source; the concrete implementation failure; and why it must be resolved before implementation. Record `late-nonblocking` and `out-of-scope` work without silently changing the issue.

The agent independently applies the shared applicability test to every relay finding. Reject or defer a generally sound recommendation when it lacks current authority, exposure, failure, or scope necessity; use the narrowest adequate measure for an admitted blocker. Repetition without new evidence does not reopen the finding.

The second submission includes the complete current plan, ledger, revision summary, and verified repository evidence.

### Third submission — final plan convergence

```text
This is the final implementation/test-plan convergence review. The issue is
frozen. Do not restart design review, reopen resolved findings without evidence,
or add optional scope.

Review only unresolved ledger findings, revision regressions, new authoritative
evidence, and proven critical late findings. For each blocker, give its ID,
classification, exact source, concrete implementation failure, why it blocks,
current applicability evidence, and the minimum sufficient correction. A generic
best practice without a real current exposure and failure is non-blocking.

Return exactly one verdict:
- READY: no admissible implementation blocker remains.
- CORRECT: only deterministic implementation-local corrections remain.
- ESCALATE: a product decision, material trade-off, or fundamental re-plan is
  required.

Do not request another full review.

Issue: <url>

--- project constraint profile ---
<evidence and unknowns>

--- finding ledger ---
<complete ledger>

--- revision summary ---
<changes since the previous round>

--- implementation/test plan ---
<complete plan>
```

Apply the shared continuation protocol:

- `READY` → complete the stage handoff; implementation may begin under its separate authority.
- `CORRECT` → make and verify the minimum correction, update the ledger, complete the stage handoff, and require downstream tests and PR review to cover the corrected area.
- Product/public-contract/compatibility/migration/security/privacy decision or absolute disagreement → one checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.
- Fundamental re-plan or unready issue → one return-to-planning recommendation in `default`; in `auto`, use the one-time readiness fallback only when all its conditions hold, otherwise return `BLOCKED_HANDOFF`. A fundamental re-plan alone does not authorize fallback or a review-budget reset.

The budget belongs to the current plan cycle. Only an explicit user-authorized material change to the issue or engineering risk boundary starts another full cycle; carry the ledger and reason forward.

## Phase 3 — Stage handoff

Return `PLAN_READY` only when readiness and the applicable plan-review continuation permit implementation, all required deterministic corrections are verified, and no agent-verified admissible blocker remains. Preserve the complete current plan, its exact revision, the authoritative issue revision, repository baseline and relevant working-tree state, acceptance/test mapping, validation requirements, and known assumptions in the shared [handoff record](./README.md#stage-handoffs-and-delegation).

Include review task IDs and verdicts, the continuation decision, unresolved non-blocking risks, the stable ledger, consumed and remaining contract/plan/PR review budgets where established, and whether readiness fallback was used. Identify any corrected area that downstream tests and PR review must cover. `PLAN_READY` does not require another review submission or routine user checkpoint.

For standalone use, stop after the handoff. In a composition, return to the caller for [`implementation.md`](./implementation.md) with the same session, mode, approved scope, and implementation authority. The downstream stage consumes this reviewed plan without repeating discovery or plan review solely because the agent changed.

If blocked, follow the selected mode's consolidated checkpoint or `BLOCKED_HANDOFF` rule and preserve the plan, missing-decision set, ledger, remaining budgets, fallback record, and evidence. Never reset a review cycle or take another automatic fallback because the stage is delegated or resumed.
