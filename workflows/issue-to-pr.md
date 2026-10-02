# Workflow: Rough issue → agent-ready issue → implementation → PR

**Required references**:

- Relay mechanics: [`agent-instructions.md`](../agent-instructions.md)
- Execution modes: [`workflows/README.md`](./README.md#execution-modes)
- Session selection: [`workflows/README.md`](./README.md#relay-session-selection)
- Review protocol: [`review-convergence.md`](./review-convergence.md)
- Downstream implementation: [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md)

---

## Purpose and routing

Use this workflow to turn a placeholder, rough draft, or ambiguous problem report into an explicit issue contract, publish it through the selected checkpoint, and continue through the shared implementation workflow.

Use the faster downstream workflow directly when scope, non-goals, acceptance criteria, dependencies, and product decisions are already settled. Do not use either workflow for trivial edits, exploratory learning without an implementation contract, or when the user explicitly declines refinement or relay.

Route from the actual issue and repository context, not labels.

## Preconditions

- The full issue is available by URL or complete text.
- Repository instructions and relevant product, architecture, and contract sources are accessible.
- Resolve the task-specific session at invocation preflight using the shared session-selection rule. Relay must be reachable and the selected or newly created session usable before each required submission.
- The user authorized refinement, publication under the selected mode, implementation, and relay review.
- Record `default` when no mode is specified; pin the session and mode through the downstream workflow.

## Phase 1 — Independent decision discovery

Identify every material decision required for an implementable issue contract.

Use the independent-discussion barriers from `agent-instructions.md`:

1. Submit the issue or accessible URL to relay first and request an independent list of blocking decision points plus the project-stage facts needed to judge them.
2. Before reading the reply, inspect the repository and persist the agent's own decision list and project constraint profile to a visible draft.
3. Compare overlap, agent-only points, relay-only points, and substantive conflicts.
4. Verify repository claims and discuss only material gaps.

Cover scope and non-goals, testable acceptance criteria, public contracts and compatibility, migration or rollout, failure and operational constraints, security/privacy/performance, dependencies, sequencing, and naming where relevant.

The project constraint profile is a concise evidence summary, not a new design document. Record only dimensions that can change the current contract: release state and milestone purpose; real or committed near-term consumers and deployments; persisted production data or long-lived artifacts; compatibility/versioning commitments; reversibility and failure cost; and security, privacy, or regulatory boundaries. Use it to select the minimum sufficient durability for the current stage. Do not introduce release-grade versioning, migration, deprecation, compatibility, or operational machinery merely because it is generally useful.

Stop when no unresolved decision blocks drafting, another round adds no substantive point, or remaining differences are wording or optional follow-ups. Use at most three discussion follow-up rounds; `auto` does not add more.

User-owned product, policy, UX, public-contract, and scope trade-offs cannot be silently resolved unless the user explicitly delegated that boundary. Batch unresolved decisions and substantive disagreements into one checkpoint in `default`; in `auto`, resolve repository facts and deterministic in-scope choices from evidence, then return one `BLOCKED_HANDOFF` if an authority blocker or absolute disagreement remains.

## Phase 2 — Draft and review the issue contract

Create a visible local draft using the target repository's issue template. Include:

1. Problem and motivation.
2. Scope, exclusions, and non-goals.
3. Concrete, testable acceptance criteria.
4. Dependencies and sequencing.
5. The evidence-based lifecycle/compatibility posture and only the compatibility, migration, security, and operational requirements applicable now.
6. Risks and deferred follow-ups.
7. Resolved decisions that prevent implementation ambiguity.

Never hide a required user decision under “open questions.” Route it through the mode-aware Phase 1 outcome.

### Initial review

```text
Act as a strict product and engineering reviewer for this refined issue body.

Return the complete set of currently identifiable blockers. Check scope,
non-goals, executable acceptance criteria, dependencies, risks, compatibility,
and unresolved decisions. For each blocker, cite the issue section or
authoritative source, explain the implementation ambiguity or failure, and give
the minimum correction.

Evaluate applicability before severity. A general best practice is a blocker
only when required by the current contract or repository policy, or omission
causes a concrete current failure for a real consumer, persisted artifact,
security boundary, or release commitment. State that basis, affected exposure,
failure, why this issue must address it now, and why a simpler reversible
measure is insufficient.

Also identify requirements in the draft that impose release-grade versioning,
migration, compatibility, deprecation, or operations without current evidence;
recommend the minimum sufficient alternative. Project maturity is evidence, not
a blanket exemption.

Separate blockers from wording, style, optional enhancements, and follow-up
work. If no blocker remains, state that the issue is agent-ready.

Issue or placeholder: <url if available>

--- project constraint profile ---
<evidence and unknowns>

--- refined issue draft ---
<complete draft>
```

Apply the three-round budget and stable finding ledger from `review-convergence.md`. For later findings:

- `critical-late-finding` requires the exact issue section or source, resulting ambiguity or failure, affected acceptance criterion or contract boundary, and why this issue must resolve it.
- `user-decision` identifies a material trade-off outside agent authority.
- `late-nonblocking` and `out-of-scope` are recorded as exclusions, deferred work, or remaining risk.

The agent independently applies the shared applicability test to every relay finding. A repeated general recommendation without new authority or failure evidence does not reopen a rejected or deferred finding. If the draft's explicit frozen requirement is materially disproportionate, record one contract-applicability challenge rather than silently weakening it.

The second submission includes the complete current body, ledger, and revision summary.

### Third submission — final contract convergence

```text
This is the final contract-convergence review. Do not restart product discovery,
reopen resolved findings without evidence, or add optional scope.

Review only unresolved ledger findings, revision regressions, new authoritative
evidence, and proven critical late findings. For each blocker, give its stable
ID, classification, exact source, concrete implementation failure, why it blocks
an agent-ready contract, current applicability evidence, and the minimum
sufficient correction or user decision. A generic best practice without a real
current exposure and failure is non-blocking.

Return exactly one verdict:
- READY: no admissible contract blocker remains.
- CORRECT: only deterministic contract-local corrections remain.
- ESCALATE: a user-owned decision or fundamental re-draft is required.

Do not request another full review.

Issue or placeholder: <url if available>

--- project constraint profile ---
<evidence and unknowns>

--- finding ledger ---
<complete ledger>

--- revision summary ---
<changes since the previous round>

--- refined issue draft ---
<complete draft>
```

After the third response, apply the shared continuation protocol:

- `READY` → proceed to Phase 3.
- `CORRECT` → make and verify the minimum contract-local correction, update the ledger, then proceed without another unrestricted review.
- User-owned decision or absolute disagreement → one checkpoint in `default`, or `BLOCKED_HANDOFF` in `auto`.
- Fundamental re-draft → require user agreement in `default`; do not reset automatically in `auto`.

The budget belongs to the current contract revision cycle. Only a user-requested or user-authorized material contract change starts a new cycle; carry the ledger and record the reason. Editorial changes do not reset it.

## Phase 3 — Mode-aware publication

### `default`

Present the exact reviewed or deterministically corrected body, review status, and remaining risks.

- Approved → publish with a body file while preserving unrelated metadata.
- Editorial request → apply it, verify unchanged semantics, and present the exact body again without resetting review.
- Material contract request → record a new authorized cycle and return to Phase 1 or 2.
- Aborted → leave the draft, ledger, and decision record available.

### `auto`

Publish with a body file without routine exact-body approval only when no `user-decision`, authority blocker, absolute disagreement, or agent-verified contract blocker remains; the body stays within stated intent and authorized scope; and deterministic post-review corrections and risks are recorded. Otherwise do not publish the material change and return one `BLOCKED_HANDOFF`.

After publication, read the remote issue back and verify rendered body, links, checklists, issue type, milestone, and every intentionally changed field. Correct publication errors without changing the approved or pre-authorized contract.

## Phase 4 — Continue through implementation

The remote issue is now authoritative. Continue at Phase 1 of `agent-ready-issue-to-pr.md` with the same session and mode, using the remote URL and preserving the approved or pre-authorized scope. Do not repeat refinement.

When entered through the downstream workflow's [automatic readiness fallback](./agent-ready-issue-to-pr.md#automatic-readiness-fallback), carry its fallback-used record, repository/issue and workspace/branch identity, project constraint profile, finding ledger, evidence, and consumed review rounds back into implementation. Resume with the remaining applicable budget; this return does not authorize a new plan cycle or another automatic fallback.

Never let agent-relay agreement replace user product authority, silently expand scope, retry relay automatically after pause/captcha, or duplicate downstream PR rules here.
