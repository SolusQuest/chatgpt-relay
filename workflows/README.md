# Workflows

These files orchestrate multi-stage work that may use gpt-relay. Use `agent-instructions.md` for relay mechanics and `api.md` only for protocol details. An entry workflow may require a linked shared protocol or compose another workflow; follow those links at the stated boundary.

## Invocation

```text
Workflow: issue-to-pr | agent-ready-issue-to-pr
Mode: default | auto
Issue: <url>
Relay session: <task-specific session id>
```

If mode is omitted, use `default`. Record the selected mode before Phase 1, preserve it across composed workflows, and never change it without the user.

## Execution modes

- **`default`** preserves each workflow's explicit user checkpoints.
- **`auto`** pre-authorizes normal, reversible, in-scope work through the final handoff without routine approvals or review-budget renewal requests.

Both modes use identical validation gates, review budgets, finding rules, and exact-head requirements. `auto` does not add relay rounds or ask relay whether execution may continue; the agent applies [`review-convergence.md`](./review-convergence.md) and records the decision.

Where the active workflow permits, `auto` covers refined-issue publication, branches, commits, pushes, draft PR creation and updates, CI and review fixes, and review-thread replies or resolution. It never authorizes ready-for-review, merge, issue closure, release, deployment, unrelated metadata changes, new credentials or paid resources, destructive action, or silent product-scope expansion.

Stop dependent work only for:

- **Authority blocker** — a material product, policy, UX, public-contract, compatibility, migration, security, privacy, scope, credential, destructive-action, or other decision the user did not delegate.
- **Absolute disagreement** — agent and relay materially disagree about a blocker; authoritative evidence cannot resolve it; the outcome crosses a user-owned boundary or creates high-impact risk; and no conservative in-scope path is safe.

Repeated or unsupported findings, severity wording, style preferences, repository claims contradicted by evidence, and deterministic in-scope corrections are not absolute disagreements. In `auto`, complete independent safe work and return one consolidated `BLOCKED_HANDOFF` instead of asking sequential questions or extending review automatically.

## Available workflows

| File | Purpose |
|---|---|
| [`issue-to-pr.md`](./issue-to-pr.md) | Rough issue → decision discovery → reviewed issue contract → mode-aware publication → shared implementation workflow |
| [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) | Frozen agent-ready issue → reviewed plan → implementation → remote draft PR → integrated CI/GitHub/relay convergence → handoff and post-handoff feedback re-entry |
| [`review-convergence.md`](./review-convergence.md) | Shared bounded-review budget, finding ledger, later-finding, and continuation protocol |

## Authoring rule

Keep workflow files stage-specific. Reference relay mechanics and shared convergence rules instead of repeating them; state user checkpoints, termination conditions, and downstream handoffs explicitly; never duplicate implementation or PR gates already owned by another workflow.
