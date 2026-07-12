# Workflows

Multi-step orchestration templates that use gpt-relay as one of the moving
parts. Each workflow file is **self-contained enough** to hand to an agent
directly; it references, but does not duplicate, `agent-instructions.md`
(relay API + usage patterns) and `skills/gpt-relay-review/SKILL.md`.

## How to use

- **Agent needs relay only**: send `agent-instructions.md`. The workflow
  files are unnecessary for one-shot review / discussion.
- **Agent needs a specific multi-step process**: send the workflow file
  directly. It will pull `agent-instructions.md` when the agent needs API
  details.
- **New agent, fresh session**: send both.

Workflows are **not** required to use relay. When they do, they explain the
purpose and expectations; the agent is responsible for the mechanics via
agent-instructions.md.

## Available workflows

| File | When to use |
|---|---|
| [`issue-to-pr.md`](./issue-to-pr.md) | Placeholder / rough issue → refined issue → implementation → tests → PR → handoff. 8 phases; ~20-60 min of orchestration overhead. Uses discussion mode at decision points (Phase 1: decision-point brainstorm; Phase 5: test coverage brainstorm). |

## Adding a workflow

When adding one, follow the shape of `issue-to-pr.md`:
- **Reference** existing docs; don't restate mechanics
- **Explicit phases** with numbered goals and termination criteria
- **User checkpoints** where the workflow must stop and hand off
- **Global rules** at the bottom (never auto-merge, same session, pause
  handling, degradation signals)
- **When not to use it** section up front — as important as when to use
