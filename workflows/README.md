# Workflows

Multi-step orchestration templates that use gpt-relay as one of the moving parts. A workflow may compose another workflow for shared downstream phases; the entry workflow states exactly where the handoff occurs. Relay mechanics remain in `agent-instructions.md`, and execution uses the root `gpt-relay` CLI or its HTTP API.

## How to use

- **Agent needs relay only**: send `agent-instructions.md`. The workflow files are unnecessary for one-shot review or discussion.
- **Agent needs a specific multi-step process**: send the entry workflow. The agent must read `agent-instructions.md` for relay mechanics and follow any explicitly linked downstream workflow at the stated phase boundary.
- **New agent, fresh session**: provide the entry workflow and repository access so its references can be resolved.

Workflows are **not** required to use relay. When they do, they explain the purpose and expectations; the agent is responsible for the mechanics via `agent-instructions.md`.

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
