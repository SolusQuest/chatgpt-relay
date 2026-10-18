# Workflows

These files orchestrate multi-stage work using gpt-relay. Use [`agent-instructions.md`](../agent-instructions.md) for Relay mechanics and [`api.md`](../api.md) for protocol details. Load linked shared rules and stages at their stated boundaries.

## Invocation

Full issue-to-PR composition:

```text
Workflow: issue-to-pr | agent-ready-issue-to-pr
Mode: default | auto
Issue: <url>
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
Relay effort: <optional explicit override>
```

Standalone or delegated stage:

```text
Workflow: design | plan | implementation
Mode: default | auto
Issue: <url or complete issue text>
Stage handoff: <artifact path/reference or complete record, required for implementation>
Relay session: <existing task-specific session ID or sessionRef when established>
Relay Project: <optional Project ID/name, or no-project, when no session is established>
Relay effort: <optional explicit override>
```

Milestone issue-graph publication:

```text
Workflow: milestone-to-issue-graph
Mode: default | auto
Milestone: <existing open milestone url or owner/repo milestone number>
Refinement parent: <issue url>
Design authority: <document or merged PR url>@<exact commit SHA>
Graph structure: auto | compact | tracked
Relay session: <optional existing session ID or sessionRef>
Relay Project: <optional Project ID/name, or no-project, for a new session>
Relay effort: <optional explicit override>
Close refinement parent: yes | no
```

For milestone graphs, both structures require an existing refinement parent with a coordination role; independent tasks without one use the repository's ordinary issue publication rules. Omitted structure means `auto`: use `compact` (`parent → leaf`) when the parent can provide all delivery tracking, or `tracked` (`parent → tracker → leaf`) when delivery directions need independent coordination. Compact content is reviewed as one complete graph batch followed by deterministic remote verification; an additional final remote Relay review requires explicit user or binding project authority for a distinct independent acceptance check. Tracked content uses tracker and per-tracker leaf batches plus final remote review. `Close refinement parent` applies only to `tracked`; the compact parent remains open as the delivery tracker. Resume preserves the recorded structure and review requirements; older executions use `tracked`.

The initial graph content review also checks workflow applicability and structure choice, including whether ordinary publication without a parent is sufficient. This check is part of the existing first content submission. A justified no-parent recommendation routes to the repository's ordinary publication procedure; it adds no third graph structure or separate review gate.

Omitted mode means `default`. Record it before the first workflow phase and preserve it unless the user changes it. Standalone stages stop at their own outcome and grant no downstream authority. Compositions consume intermediate handoffs and continue their authorized stages without adding routine approval checkpoints.

## Stage handoffs and delegation

| Entry | Composition | Terminal outcome |
|---|---|---|
| `issue-to-pr` | Design → Plan → Implementation | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |
| `agent-ready-issue-to-pr` | Plan → Implementation | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |
| `design` | Decision discovery → contract review → publication/readback | `DESIGN_READY` or `BLOCKED_HANDOFF` |
| `plan` | Readiness → implementation/test plan → plan review | `PLAN_READY` or `BLOCKED_HANDOFF` |
| `implementation` | Reviewed plan → code/tests → PR convergence/handoff | `READY_FOR_HUMAN_REVIEW` or `BLOCKED_HANDOFF` |

Stage outcomes report existing completion conditions, adding no review, approval gate, or authority. Artifact verdicts such as `READY` and `CORRECT` retain their meanings under [`review-convergence.md`](./review-convergence.md); they do not substitute for a handoff. Projects own agent/model selection and delegation mechanics; the invoker consumes handoffs and returns one consolidated final or blocked result.

**Reference loading:** read the active entry/stage and relevant sections of its **Required shared rules**. Load **Boundary references** only for routing, running/delegating that stage, fallback, or return. Links and the catalog are not recursive reading lists. A coordinator loads each stage when active/delegated; a delegated agent needs its stage, shared rules, relevant repository/contract sources, and complete handoff. It reads the full entry only when coordinating the composition. Deferred reading never omits an active-stage rule or weakens handoff validation; consuming a valid handoff does not repeat its producing procedure.

Persist complete handoff content or accessible references using the target project's artifact conventions. To retain Relay CLI results, use `--json --output <path>` as described in the [CLI lifecycle](../agent-instructions.md#cli-lifecycle), preserving the command's exit code and task/operation identity:

| Field | Required content |
|---|---|
| Execution identity | Repository/issue; workspace/worktree and branch when selected; composition or standalone stage; phase and completion/blocker status |
| Authority and mode | Authorized scope/actions, exclusions, unresolved user decisions, inherited mode |
| Relay identity | Same task-specific session ID/ref and original submitted/pending task IDs for observation without replay; requested/effective effort, fallback policy/reason and verification evidence |
| Artifacts and baseline | Exact issue/draft/plan revisions as applicable, repository baseline, relevant working-tree state, and readable content/references |
| Decisions and verification | Constraint profile, decisions, dependencies, assumptions, acceptance/test mapping and validation requirements when established; review/correction evidence and agent continuation decision |
| Review continuity | Stable finding ledger and revision/head lineage; established contract/plan/PR cycles and consumed/remaining rounds; applicable discovery and targeted-closure usage |
| Fallback and next action | Fallback-used flag, origin/authority; risks, deferred work, blockers, authorized next stage/return point |

Only established fields need values; Design need not invent a plan, PR, or branch. Receivers verify sources/state, reuse applicable completed work, and act on concrete changed evidence under the owning stage. Missing/inconsistent required evidence means unknown readiness: reconcile authoritative artifacts and original task records before dependent work. Never manufacture approval or open a new cycle to replace lost context.

Contract, plan, and PR review budgets remain separate. Passing a stage neither consumes nor replenishes another budget. Stage/agent/model/chat changes, effort changes or fallback, standalone invocation, delegation, composition, and resume never reset cycles, rename findings, drop pending tasks, replace an established session, or expand authority; omitted invocation fields inherit recorded identity.

Plan owns the one-time [readiness fallback](./plan.md#automatic-readiness-fallback). When eligible before implementation, run only Design from Phase 1 through contract review, publication/readback, and `DESIGN_READY`, then return to the existing Plan stage with remaining budgets; propagate blocked Design. Implementation deviations and authorized PR re-entry follow their stage rules.

## Relay session selection

Resolve the session at invocation preflight, before substantial work. A user-supplied ID/ref or the execution chain's established session takes precedence and persists across phases, compositions, fallback, and resume. Omission does not request a new session. Never substitute an idle/recent/previous-task session or replace an unavailable supplied session.

When no session exists:

- **`default`**: ask early whether to create one or use a supplied ID/ref. An explicit creation request already answers this. Continue independent safe work, but wait for selection before submission.
- **`auto`**: create a task-specific session without confirmation; notify the user of the request, ref, and Project, continue independent work, and report successful creation after conversation binding.

Create with the first substantive prompt and necessary context, never an ID-only placeholder. Persist the ref before submission and preserve independent-discussion barriers, review budgets, and required gates. Follow [`agent-instructions.md`](../agent-instructions.md#new-session-mode) for creation/recovery mechanics.

Honor the user's Project; otherwise inspect catalog names/descriptions and choose an appropriate Project. If none can be established, explicitly use `--no-project` with sufficient context. An inaccessible or unresolved user-required Project is a mode-aware blocker, not permission to substitute. Optional discovery has partial coverage.

Acceptance is not creation: `pending` is in progress, `created` requires a bound conversation ID, and `unknown` requires observation. Missing IDs and wait timeouts permit neither another page nor prompt replay. A bound session survives first-task failure. Continue independent safe work while waiting; each required Relay result still gates its dependent phase. Failures use the active mode's recovery/checkpoint or `BLOCKED_HANDOFF` rules.

## Relay effort policy

Resolve effort at invocation preflight with the session: an explicit user override takes precedence, followed by the execution chain's recorded effective policy and fallback settings. Delegated stages, composition, readiness fallback, resume and PR re-entry inherit that policy; entering another stage does not select a new default. Apply the following defaults only to a new execution without an inherited policy:

| Workflow entry | Requested effort | Pre-send fallback |
|---|---|---|
| `milestone-to-issue-graph` | `pro` | `max` |
| Every other workflow, including standalone Design, Plan and Implementation | `max` | `error` |

Preserve the model family selected by the user on the webpage. An explicit effort override uses `error` unless the user also supplies a fallback policy. Bare CLI use remains opt-in.

Apply the resolved policy and inspect results using [the agent effort procedure](../agent-instructions.md#apply-the-workflow-effort-policy). It covers creation, existing-session controls, operation observation and result verification. Post-reply `unknown` is a recorded warning for ordinary reviews and does not alone block their dependent phases; actual `mismatch` remains blocking. Require post-reply `verified` only when the user or a binding workflow requirement explicitly requires proof of executed effort. Pre-send selection and control requirements still apply; load [API details](../api.md#effort-selection) only when needed for protocol work or diagnosis.

The milestone's Pro-to-max fallback applies only before Send, when the known UI shows Pro unavailable and max can be positively verified. It never falls further to High or treats unknown page state, timeout or generic rate limiting as Pro unavailability. If fallback occurs, notify the user, record requested Pro/effective max and the reason/evidence, and retain max for the rest of this execution. A new independent invocation may reconsider the default.

Platform downgrade after Send is separate from this fallback. Actual mismatched effort uses the active workflow's checkpoint/blocked outcome. Unverifiable post-reply effort is a recorded warning for ordinary reviews; only an explicit strict proof requirement blocks on unknown. Keep the reply and original task identity without replaying the prompt.

Persist effort continuity in the shared [handoff record](#stage-handoffs-and-delegation), including the original request when the effective policy changes to max.

## Execution modes

- **`default`** preserves explicit workflow checkpoints.
- **`auto`** pre-authorizes normal, reversible, in-scope work through final handoff without routine approvals or budget-renewal requests.

Both modes retain identical gates, budgets, finding rules, and exact-head requirements. The agent applies [`review-convergence.md`](./review-convergence.md), records continuation, and never adds rounds or asks Relay separately whether `auto` may continue.

Where the workflow permits, `auto` covers issue refinement/publication, branches, commits/pushes, draft PRs/updates, CI/review fixes, thread replies/resolution, and its explicitly owned initial exact-gate draft-to-ready transition. It does not authorize merge, issue closure, release/deployment, unrelated metadata, new credentials/paid resources, destructive action, or silent scope expansion.

Stop dependent work for:

- **Authority blocker**: an undelegated material product, policy, UX, public-contract, compatibility, migration, security/privacy, scope, credential, destructive-action, or other user decision.
- **Absolute disagreement**: a material agent/Relay blocker dispute unresolved by authoritative evidence, crossing a user boundary or creating high-impact risk, with no safe conservative in-scope path.

Repetition, severity wording, style, unsupported/contradicted claims, and deterministic in-scope corrections do not meet that threshold. In `auto`, complete independent safe work and return one consolidated `BLOCKED_HANDOFF`; do not ask sequential questions or extend review automatically.

## Available workflows

| File | Purpose |
|---|---|
| [`issue-to-pr.md`](./issue-to-pr.md) | Rough-issue composition |
| [`agent-ready-issue-to-pr.md`](./agent-ready-issue-to-pr.md) | Frozen-issue composition and authorized feedback re-entry |
| [`design.md`](./design.md) | Decision discovery, issue contract, publication/readback |
| [`plan.md`](./plan.md) | Readiness, implementation/test plan, one-time fallback |
| [`implementation.md`](./implementation.md) | Code/tests, PR convergence, exact-head handoff, authorized re-entry |
| [`milestone-to-issue-graph.md`](./milestone-to-issue-graph.md) | Compact graph or tracker/leaf content review, idempotent publication, exact remote verification and review |
| [`review-convergence.md`](./review-convergence.md) | Shared review budget, prompts, finding ledger, continuation |

## Authoring rule

Keep workflows stage-specific, with required shared rules and conditional boundary references. Reference shared mechanics/protocols; state checkpoints, termination, and handoffs explicitly. Keep stage-owned exceptions and avoid duplicating another stage's implementation/PR gates.
