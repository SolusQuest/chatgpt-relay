# Workflows

These files orchestrate multi-stage work that may use gpt-relay. Use `agent-instructions.md` for relay mechanics and `api.md` only for protocol details. An entry workflow may require a linked shared protocol or compose another workflow; follow those links at the stated boundary.

## Invocation

For issue-to-PR work:

```text
Workflow: issue-to-pr | agent-ready-issue-to-pr
Mode: default | auto
Issue: <url>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
```

For milestone issue-graph publication:

```text
Workflow: milestone-to-issue-graph
Mode: default | auto
Milestone: <existing open milestone url or owner/repo milestone number>
Refinement parent: <issue url>
Design authority: <document or merged PR url>@<exact commit SHA>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
Close refinement parent: yes | no
```

If mode is omitted, use `default`. Record the selected mode before the first workflow phase, preserve it across composed workflows, and never change it without the user.

## Relay session selection

Resolve the task's Relay session during invocation preflight, before substantial workflow work. A user-supplied session ID or `sessionRef`, or the session already recorded for this execution chain, takes precedence. Preserve that identity across phases, composed workflows, readiness fallback and resumed execution. An omitted invocation field does not mean an established task needs another session. Never substitute an idle, recent or previous-task session, or replace a supplied session merely because it is unavailable.

When no task-specific session is supplied or already established:

- **`default`**: ask early whether the user wants a new session or will supply an existing ID/ref. Do not defer the question until a Relay gate is reached. Continue independent safe local work while awaiting the answer, but wait for the selection before submitting to Relay. An explicit request to create a new session already answers this question.
- **`auto`**: create a new task-specific session without asking for confirmation. Notify the user of the new-session request and selected Project, retain its ref and first task ID, and continue independent work immediately. Once the conversation ID is bound, report that the session was created and continue Relay work in it without an additional checkpoint.

Creation includes the first substantive workflow prompt and necessary initialization context; do not send a placeholder message merely to obtain an ID. Generate and persist the ref before submission, and pin it for the entire execution chain. Follow [`agent-instructions.md`](../agent-instructions.md#new-session-mode) for creation, status checks and recovery. New-session initialization must preserve the active workflow's independent-discussion barriers, review budgets and required gates.

For creation, honor the user's Project selection first. Otherwise inspect the local catalog's names and descriptions and select an appropriate Project for the task. If no appropriate Project can be established, explicitly use `--no-project` and provide the required context in the first prompt. A user-required Project that cannot be resolved or accessed follows the mode's blocker rule; it does not authorize fallback to another Project or an ordinary chat. Project discovery is an optional aid and its partial results are not an exhaustive catalog.

Distinguish request acceptance from successful creation: `pending` means creation is in progress; `created` requires a bound conversation ID; `unknown` requires recovery observation. Neither a missing ID nor a wait timeout authorizes a second page or prompt replay. A bound session survives first-task failure. Continue independent safe work while awaiting creation or replies, but satisfy each required Relay gate before its dependent phase. Execution failures still follow the active mode's recovery/checkpoint or `BLOCKED_HANDOFF` rules; automatic session creation does not waive them.

## Execution modes

- **`default`** preserves each workflow's explicit user checkpoints.
- **`auto`** pre-authorizes normal, reversible, in-scope work through the final handoff without routine approvals or review-budget renewal requests.

Both modes use identical validation gates, review budgets, finding rules, and exact-head requirements. `auto` does not add relay rounds or ask relay whether execution may continue; the agent applies [`review-convergence.md`](./review-convergence.md) and records the decision.

Where the active workflow permits, `auto` covers refined-issue publication, branches, commits, pushes, draft PR creation and updates, CI and review fixes, review-thread replies or resolution, and an initial exact-gate draft-to-ready transition explicitly owned by that workflow. It never authorizes merge, issue closure, release, deployment, unrelated metadata changes, new credentials or paid resources, destructive action, or silent product-scope expansion.

Stop dependent work only for:

- **Authority blocker** — a material product, policy, UX, public-contract, compatibility, migration, security, privacy, scope, credential, destructive-action, or other decision the user did not delegate.
- **Absolute disagreement** — agent and relay materially disagree about a blocker; authoritative evidence cannot resolve it; the outcome crosses a user-owned boundary or creates high-impact risk; and no conservative in-scope path is safe.

Repeated or unsupported findings, severity wording, style preferences, repository claims contradicted by evidence, and deterministic in-scope corrections are not absolute disagreements. In `auto`, complete independent safe work and return one consolidated `BLOCKED_HANDOFF` instead of asking sequential questions or extending review automatically.

## Available workflows

| File | Purpose |
|---|---|
| [`issue-to-pr.md`](./issue-to-pr.md) | Rough issue → decision discovery → reviewed issue contract → mode-aware publication → shared implementation workflow |
| [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) | Frozen agent-ready issue → reviewed plan → implementation → remote draft PR → integrated CI/GitHub/relay convergence → handoff and post-handoff feedback re-entry |
| [`milestone-to-issue-graph.md`](./milestone-to-issue-graph.md) | Authoritative milestone design → bounded tracker/leaf batch reviews → idempotent GitHub issue-graph publication → exact remote verification and refinement handoff |
| [`review-convergence.md`](./review-convergence.md) | Shared bounded-review budget, finding ledger, later-finding, and continuation protocol |

## Authoring rule

Keep workflow files stage-specific. Reference relay mechanics and shared convergence rules instead of repeating them; state user checkpoints, termination conditions, and downstream handoffs explicitly; never duplicate implementation or PR gates already owned by another workflow.
