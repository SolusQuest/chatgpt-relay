# Workflows

Multi-step orchestration templates that use gpt-relay as one of the moving parts. A workflow may compose another workflow for shared downstream phases; the entry workflow states exactly where the handoff occurs. Agent-facing relay mechanics remain in `agent-instructions.md`; protocol details remain in `api.md`.

## How to use

- **Agent needs relay only**: send `agent-instructions.md`. The workflow files and `api.md` are unnecessary for ordinary one-shot review or discussion.
- **Agent needs a specific multi-step process**: send the entry workflow. The agent must read `agent-instructions.md` for relay mechanics and follow any explicitly linked downstream workflow at the stated phase boundary.
- **New agent, fresh session**: provide the entry workflow and repository access so its references can be resolved.

Workflows are **not** required to use relay. When they do, they explain the purpose and expectations; the agent follows `agent-instructions.md` and reads `api.md` only when protocol-level detail is needed.

## Execution modes

Every workflow runs in one execution mode selected at the entry point:

- **`default`** — preserve the workflow's explicit user checkpoints. This is the mode when none is specified.
- **`auto`** — the user pre-authorizes uninterrupted execution through the final handoff for normal, reversible, in-scope work. The agent does not pause for routine approvals, deterministic corrections, repository-fact verification, review preferences, or a request to renew exhausted review budget.

The selected mode is inherited by every composed downstream workflow. The agent must record it before Phase 1 and must not change it without the user.

A concise invocation can be:

```text
Workflow: issue-to-pr | agent-ready-issue-to-pr
Mode: default | auto
Issue: <url>
Relay session: <task-specific session id>
```

Execution mode controls human checkpoints, not review rigor. `default` and `auto` use the same validation gates, relay review budgets, finding admissibility rules, and exact-head requirements. `auto` never adds full review rounds or a separate relay request asking whether execution may continue. Continuation is an agent-owned semantic decision based on the workflow, authoritative evidence, and the user's authorization boundary.

A review submission consumes a workflow round only when relay returns a
substantive review of the requested artifact. URL-access failure, pause, captcha,
transport failure, clearly truncated output, or an off-topic response is an
execution failure rather than an additional review round; follow
`agent-instructions.md` recovery rules and never use this distinction to retry a
forbidden paused or rate-limited session.

Within a workflow that explicitly permits the action, `auto` authorizes refining and publishing an issue without a routine exact-body approval, creating branches and commits, pushing the implementation branch, opening and updating a draft PR, fixing CI and review findings, and answering or resolving review threads according to repository policy. It does **not** authorize marking a PR ready, merging, closing an issue, releasing, deploying, changing unrelated metadata, using new credentials or paid resources, or expanding the user's stated product scope.

Two conditions may still prevent uninterrupted completion:

- **Authority blocker** — progress requires a product, policy, UX, public-contract, compatibility, migration, security, privacy, scope, destructive-action, credential, or other decision that the user has not delegated.
- **Absolute disagreement** — agent and relay materially disagree about a blocking finding; authoritative code, contract, test, CI, and reproduction evidence cannot resolve it; the outcome crosses a user-owned material boundary or creates high-impact risk; and no conservative in-scope path is safe.

A repeated finding, unsupported late concern, severity-label difference, style preference, repository claim contradicted by authoritative evidence, or deterministic in-scope correction is not an absolute disagreement.

After each substantive relay gate in `auto`, record the continuation decision
without sending it back to relay for meta-review:

```text
Decision: CONTINUE | BLOCKED_HANDOFF
Phase: <phase>
Relay verdict: <verdict>
Open verified blocker IDs: <ids or none>
Authority blocker: yes | no
Absolute disagreement: yes | no
Evidence: <authoritative code, contract, tests, CI, or reproduction>
Next action: <action>
```

In `auto`, the agent completes every independent safe action before ending with one consolidated `BLOCKED_HANDOFF`; it does not ask a sequence of mid-run questions or automatically request more review budget. In either mode, successful execution ends with a draft-PR handoff for the user's final review, ready-for-review action, and merge decision.

## Available workflows

| File | When to use |
|---|---|
| [`issue-to-pr.md`](./issue-to-pr.md) | Placeholder / rough issue → independently discovered decision points → reviewed and user-approved agent-ready issue. It then composes the shared agent-ready workflow instead of duplicating implementation and PR gates. |
| [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) | Agent-ready issue → reviewed implementation/test plan → code and tests → remote draft PR → CI, relay, and review-thread gates → user handoff. Plan creation is agent-authored by default, with risk-triggered parallel independent discovery for high-risk or non-obvious implementation paths. |

## Adding a workflow

When adding one, follow the shape of `issue-to-pr.md`:

- **Reference** existing docs; don't restate mechanics
- **Compose** an existing workflow when it already owns the downstream phases; do not duplicate shared gates
- **Explicit phases** with numbered goals and termination criteria
- **User checkpoints** where the workflow must stop and hand off
- **Global rules** at the bottom (never auto-merge, same session, pause handling, degradation signals)
- **When not to use it** section up front — as important as when to use
