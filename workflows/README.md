# Workflows

These files orchestrate multi-stage work that may use gpt-relay. Use `agent-instructions.md` for relay mechanics and `api.md` only for protocol details. An entry workflow may require a linked shared protocol or compose another workflow; follow those links at the stated boundary.

## Invocation

For a full issue-to-PR composition:

```text
Workflow: issue-to-pr | agent-ready-issue-to-pr
Mode: default | auto
Issue: <url>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
```

For a standalone stage, including one delegated to a different agent:

```text
Workflow: design | plan | implementation
Mode: default | auto
Issue: <url or complete issue text>
Stage handoff: <artifact path/reference or complete record, required for implementation>
Relay session: <existing task-specific session ID or sessionRef when established>
Relay Project: <optional Project ID/name, or no-project, when no session is established>
```

A standalone stage stops at its own terminal outcome. A full composition consumes intermediate stage handoffs and continues its authorized stages to the existing PR outcome. Invoking a standalone stage does not authorize its downstream stages. Do not add a routine user approval checkpoint just because a composition crosses a stage or agent boundary.

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

## Stage handoffs and delegation

[`design.md`](./design.md), [`plan.md`](./plan.md), and [`implementation.md`](./implementation.md) own the existing stage rules. The two issue-to-PR entries compose them in the original order:

| Entry | Composition | Terminal outcome |
|---|---|---|
| `issue-to-pr` | Design → Plan → Implementation | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |
| `agent-ready-issue-to-pr` | Plan → Implementation | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |
| `design` | Decision discovery → contract review → publication/readback | `DESIGN_READY` or `BLOCKED_HANDOFF` |
| `plan` | Readiness → implementation/test plan → plan review | `PLAN_READY` or `BLOCKED_HANDOFF` |
| `implementation` | Reviewed plan → code/tests → PR convergence/handoff | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |

`DESIGN_READY` and `PLAN_READY` record existing stage completion conditions. They add no review submission, user approval gate, or downstream authority. Review verdicts such as `READY` and `CORRECT` retain their artifact-specific meanings under [`review-convergence.md`](./review-convergence.md); a verdict alone is not a complete stage handoff.

The invoking project may assign stages to different agents or choose models and reasoning settings. These workflows define responsibilities and continuity; the project owns delegation mechanics and model selection. The invoker consumes each applicable handoff, continues only the authorized composition, and returns one consolidated final or blocked outcome.

Read the active entry or stage and its **Required shared rules**. Read the linked shared-rule sections relevant to the invocation rather than treating the workflow catalog as a reading list. **Boundary references** and other stage/composition links are conditional: load them when routing, running or delegating the referenced stage, taking an authorized fallback, or handling a return to that stage. A link alone does not require recursively reading upstream, downstream, or full-composition procedures. The coordinator loads a stage when it becomes active or is delegated; consuming an applicable handoff does not require repeating the producing stage's procedure.

A delegated stage agent needs its current stage document, shared rules, relevant repository/contract sources, and complete handoff artifacts. The composition's identity, authority, and return point travel in the handoff; the agent reads the full entry only if it also coordinates that composition. Deferred reading does not omit any rule required for the active stage or weaken handoff validation.

Persist the handoff using the target project's existing artifact conventions. Provide complete content or accessible references, not only a chat summary. Include:

| Field | Required content |
|---|---|
| Execution identity | Repository and issue identity; workspace/worktree and branch when selected; invoking composition or standalone stage; current phase and completion/blocker status |
| Authority and mode | User-authorized scope and actions, exclusions and unresolved user decisions, and inherited `default` or `auto` mode |
| Relay identity | The same task-specific session ID or `sessionRef`, and submitted/pending task IDs needed to observe original work without replay |
| Artifacts and baseline | Exact issue, draft, and plan revisions as applicable, plus repository baseline and relevant working-tree state; readable content or references for each |
| Decisions and verification | Project constraint profile, resolved decisions, dependencies, assumptions, acceptance/test mapping and validation requirements where established, review results and correction evidence, and the agent-owned continuation decision |
| Review continuity | Stable finding ledger with artifact/head lineage, each established contract/plan/PR cycle and consumed/remaining rounds, discovery usage where applicable, and targeted-closure usage when established |
| Fallback and next action | Whether the one-time readiness fallback was used and its origin/authority; risks, deferred work, blockers, and the authorized next stage or return point |

Only established fields need values: Design need not invent a plan, PR, or implementation branch. A receiving agent verifies the relevant sources and state, reuses completed work while it remains applicable, and acts on concrete changed evidence under the owning stage's rules. Missing or inconsistent required handoff evidence is unknown readiness; reconcile it from authoritative artifacts and original task records before dependent work. Do not manufacture approval or start another review cycle to compensate for lost context.

Design contract review, Plan review, and integrated PR convergence keep their existing artifact-specific budgets. Passing one stage's review does not consume or replenish another stage's budget. A stage, agent, model, or chat change, standalone invocation, delegation, composition, or resume never resets a cycle, renames findings, drops pending tasks, creates another Relay session, or expands user authority. Inherit an established task session even when the new invocation omits it.

Plan owns the one-time [automatic readiness fallback](./plan.md#automatic-readiness-fallback). Before implementation starts, it runs only Design starting at Phase 1 through contract review, publication, and remote readback to `DESIGN_READY`, then returns to the existing Plan stage; a blocked Design propagates its blocked outcome. Readiness failure must satisfy the original authority, availability, unused-fallback, and remaining-budget conditions; missing authority, external dependencies, Relay failures, and exhausted budgets do not become fallback triggers. Implementation deviations and user-authorized PR re-entry retain their existing stage rules.

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
| [`issue-to-pr.md`](./issue-to-pr.md) | Full composition: rough issue → Design → Plan → Implementation → PR handoff |
| [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) | Full composition: frozen agent-ready issue → Plan → Implementation → PR handoff and authorized feedback re-entry |
| [`design.md`](./design.md) | Standalone decision discovery, issue contract review, and mode-aware publication/readback → `DESIGN_READY` |
| [`plan.md`](./plan.md) | Standalone readiness, implementation/test planning, and plan review; owns one-time readiness fallback → `PLAN_READY` |
| [`implementation.md`](./implementation.md) | Reviewed plan → code/tests → remote draft PR → integrated CI/GitHub/relay convergence → exact-head handoff and authorized feedback re-entry |
| [`milestone-to-issue-graph.md`](./milestone-to-issue-graph.md) | Authoritative milestone design → bounded tracker/leaf batch reviews → idempotent GitHub issue-graph publication → exact remote verification and refinement handoff |
| [`review-convergence.md`](./review-convergence.md) | Shared bounded-review budget, finding ledger, later-finding, and continuation protocol |

## Authoring rule

Keep workflow files stage-specific. Separate required shared rules from conditional boundary references so a delegated stage does not preload the full composition. Reference relay mechanics and shared convergence rules instead of repeating them; state user checkpoints, termination conditions, and downstream handoffs explicitly; never duplicate implementation or PR gates already owned by another workflow.
