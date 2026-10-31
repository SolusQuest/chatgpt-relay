# gpt-relay agent guide

gpt-relay connects an agent to the user's signed-in ChatGPT through a SQLite queue. Prefer the root `gpt-relay` CLI and its established backend binding; use HTTP for implementation/debugging or behavior the CLI lacks. [Workflows](./workflows/README.md) own orchestration, [`api.md`](./api.md) owns HTTP/environment details, and [`task-lifecycle.md`](./task-lifecycle.md) owns the full state machine.

## Core rules

- Use the supplied/established task session across phases, rounds, delegation, and resume. Resolve missing identity at preflight under [session selection](./workflows/README.md#relay-session-selection); never pick an idle/recent/previous-task session. Preserve shared [handoff](./workflows/README.md#stage-handoffs-and-delegation) revisions, authority, ledgers, budgets, and original task IDs.
- PR review requires commit, push, remote draft PR, and exact pushed head. Apply [submission scheduling](./workflows/implementation.md#review-submission-and-ci-scheduling), disclose passed/pending proof, and satisfy final CI/handoff gates separately.
- User authority owns product decisions/merge. Relay findings are inputs; the agent verifies applicability and the underlying problem under [`review-convergence.md`](./workflows/review-convergence.md), rather than mechanically implementing comments or best practices.
- Mode changes checkpoints, never budget/rigor. Exhaustion is not approval; do not ask Relay separately whether `auto` may continue.
- Pause, captcha, or explicit rate limiting stops submission without automatic retry. Complete independent safe work, then use the active mode's consolidated checkpoint/blocked outcome.

## Client state and sandbox permissions

Choose the client mode before the first Relay command, using the current harness's declared filesystem permissions. An agent restricted to workspace writes must automatically use `--stateless` when the CLI's configured client-state paths are outside its writable roots. If permission to write client state is unknown, prefer `--stateless`. Do not wait for a pending write failure, test permissions by writing outside the workspace, or request broader filesystem access solely for pending records. Ordinary mode remains available when client-state writes are permitted.

Apply `--stateless` consistently to preflight, review, observation and control commands, including `health`, `sessions`, `doctor`, `projects`, `tasks`, `operations`, `show`, `wait` and `cancel`. The examples elsewhere in this guide omit this mode flag; add it when selected. Use the established readable binding or an explicit verified backend, preserving the original server identity. Stateless mode skips pending reads/writes, automatic binding and probe log files; it does not support `bind`, `detect` or local `resume`. If support is uncertain, inspect `gpt-relay --help`; an older CLI requires an update, not a fallback that writes outside the allowed roots.

Before each new logical review, generate and retain a unique `--cri` in the task context or an existing workspace execution record. Add it to every stateless `review`, including `--new-session`. Retain the session selector and backend identity, then capture the emitted recovery metadata and task ID. Retries of the same request keep the original key/ref and effective payload; a new key belongs only to a new logical message. Carry these identifiers through the existing handoff, and recheck filesystem permissions when changing executor or machine. An explicit `--output` must target an allowed writable location.

```bash
gpt-relay health --stateless
gpt-relay review --stateless --session-ref <ref> --cri <stable-key> --file <prompt-file> --no-wait --json
gpt-relay wait --stateless --session-ref <ref> --cri <stable-key> --server <original-server> --server-id <server-uuid> --json
```

After a timeout, lost response or client-state write failure, observe the original request with `show`/`wait` by task ID, or `tasks`/`wait` with the original session selector and `--cri`. In stateless mode, pass the original `--server` and `--server-id` from recovery output; never use local `resume`. A write failure alone does not prove submission failed, and a missing lookup does not authorize a fresh key/ref or resubmission. See [stateless client recovery](./README.md#stateless-clients-and-workspace-only-agents) for output and lookup semantics.

## Preflight and context

```bash
gpt-relay health
gpt-relay sessions
gpt-relay sessions inspect --session-ref <ref>
```

Resolve/inherit identity before substantial work. Confirm reachability, selected session availability, no pause, and no unexpected active task. An absent/paused supplied session blocks execution, not permission to substitute. See **New-session mode** only when creation is needed; [diagnostics/controls](#diagnose-and-control-an-existing-session) and catalog maintenance are otherwise conditional.

Preserve the task's backend as well as its session. `bind` displays client configuration; `bind <host:port>` verifies and saves a server. Temporary `--server <address>` or `--local` overrides take precedence over `GPT_RELAY_URL` and saved binding. An unavailable binding never falls back to another server. With no configured backend, ordinary commands bind only a unique discovery result; zero or multiple results require an explicit choice. Do not clear or replace a task's binding merely to find an available session. `resume` retains foreign-backend or missing-task pending records without resubmitting; select their original server explicitly when observing them. `start` launches a foreground server independently of client binding. See [backend usage](./README.md#separate-cli-and-server-computers).

An existing task conversation retains its supplied project context and can access user-authorized GitHub URLs. Do not repeatedly resend background/full diffs unless inaccessible or misunderstood. Add complete relevant authorized material when available; missing authorization or sensitive context follows the mode's blocker rule. A new conversation needs its goal/scope, repository/material URLs, revision, and evidence. Supply relevant `AGENTS.md` content/source when Relay cannot access it; new chats inherit no earlier conversation history.

### New-session mode

Honor the user's Project. Otherwise inspect local catalog names/descriptions and resolve a suitable Project ID; with none, explicitly choose `--no-project` unless a particular Project is required. Persist an agent-owned `sessionRef` (`sr_<uuid>`) before submitting the first substantive prompt, preserving independent-discussion barriers. Creation requires that ref, nonempty text, and exactly one Project choice; never use an ID-only placeholder.

```bash
gpt-relay projects --json
gpt-relay review --new-session --session-ref <ref> --project-id <project-id> --file <prompt-file> --no-wait
gpt-relay sessions --session-ref <ref> --json
gpt-relay show <task-id>
gpt-relay review --session-ref <ref> --file <follow-up-file> --no-wait
```

Replace `--project-id` with `--no-project` for ordinary chat. `--text`, `--stdin`, wait/deadline options also work. Legacy `--session <id>` remains supported; never combine selectors.

Retain the first task ID and notify the user of requested ref/Project. Report creation only when `creationStatus: created` binds a conversation ID. In `auto`, notifications are not permission checkpoints: continue independent work while waiting, then use the same ref. Required Relay results still gate dependent work.

Same-ref creation retries with unchanged effective parameters return the original first task; changed parameters conflict. Fresh refs require confirmed creation failure. `created` survives first-task failure and does not prove page readiness. `pending`/`unknown`, missing IDs, and wait timeouts authorize no second page or replay; observe recovery. Composition/fallback/resume keep the established ref.

In ordinary mode, the CLI/client persists `clientRequestId` before each message. After a lost response, `resume` observes accepted work and retains unmatched records without resubmission. Repeating an ordinary-mode command generates a new key/message unless `--cri` is explicitly reused. Stateless agents supply and retain their own key and use the server queries under [client state and sandbox permissions](#client-state-and-sandbox-permissions). Request idempotency and the browser Send fence are separate protections.

**Catalog maintenance — only when needed:** `projects set --project-id <id> --name <name> [--description <text>]` and `projects remove --project-id <id>` change local metadata only. Omitted descriptions persist; empty text clears them. Names aid selection, but creation uses IDs. Catalog entries neither guarantee access nor form an allowlist; valid supplied IDs work with page verification. `projects discover [--save] [--no-wait]` reads visible links in open tabs without messages, navigation, or tab switching. Results include sources and `complete: false`; collapsed/unloaded Projects may be absent. Save merges names by ID, preserving descriptions/unseen entries and skipping conflicting observed names. Async discovery returns an ID for API polling.

### Apply the workflow effort policy

For a workflow, resolve or inherit the [effort policy](./workflows/README.md#relay-effort-policy) at preflight. This section owns execution steps; workflow defaults and inheritance belong to that shared policy.

For a new session, add `--effort <value> --effort-fallback <policy>` to the first substantive creation prompt under [new-session mode](#new-session-mode). These parameters participate in creation idempotency; keep them unchanged on a same-ref retry. For an existing session, require a fresh idle page, a clean composer and no queued/active work, then apply the policy before submitting a message:

```bash
gpt-relay sessions effort --session-ref <ref> --effort <value> --effort-fallback <policy> --operation-id <operation-id>
gpt-relay operations <operation-id>
```

Wait for `succeeded`, inspect requested/effective effort, and persist it with the execution record. Observe uncertain controls under the shared [operation rules](#diagnose-and-control-an-existing-session); a changed payload needs a new operation ID. For messages, `--effort` is accepted only with `--new-session`; follow-ups inherit the saved session policy.

When the workflow must retain max after a Pro-to-max fallback, run a new `sessions effort --effort max --effort-fallback error` control with the same session selector before the next message. Wait for success and preserve the original Pro request/fallback evidence in the execution record. The saved Pro policy otherwise attempts Pro again on later messages.

Read effort-enabled review results using `review --json` or `show <task-id> --json`; `tasks --json` and `resume --json` expose observed task results too. Require `effortSelection` to match the resolved policy or its allowed fallback. A failed/unknown pre-send effort control or a reply with `effortVerification.status: mismatch` blocks dependent submission or advancement. A captured reply with `status: unknown` is an effort warning for ordinary reviews: record the reason and requested/effective effort, evaluate the review normally, and continue if its substantive verdict permits. Unknown is not proof of a downgrade or of verified effort. Only an explicit user requirement or binding workflow requirement for verified post-reply effort makes unknown block advancement; ordinary workflow effort defaults alone do not impose that requirement. Missing verification results and missing replies still require inspection.

For post-reply unknown, inspect `reason`, `attempts` and `httpStatus` when present. The extension already makes bounded read-only retries. To verify the original captured reply later, run `gpt-relay tasks reverify-effort <task-id> --operation-id <id>`, observe `operations <id>`, then inspect `show <task-id> --json` again. This reads the saved exact turn IDs without sending a message, changing effort, refreshing or opening a page. It requires the original conversation to be open and observable. Older records without saved turn IDs return `missing_turn_ids`; preserve the warning rather than guessing a turn or resending. A confirmed mismatch remains blocking even after an inconclusive or contradictory later read. For accepted values, other fallback policies and error fields, consult [effort API semantics](./api.md#effort-selection).

## Artifact review

Workflow-specific prompts/verdicts belong to the active stage. For standalone reviews, request concrete required changes before optional risks, applying current applicability rather than generic best practices.

- **PR:** supply remote URL, exact pushed SHA, and passed/pending validation/execution proof with references. Pending checks are unverified; ask for specific necessary missing proof, not inferred failures from ordinary pending CI. Readiness remains the workflow's decision.
- **Unpublished issue:** supply the complete draft, asking for scope/non-goals, acceptance, dependencies, risks, compatibility, and executability; separate blockers from optional work and challenge unsupported release-grade requirements.

Use files/stdin for long text. After a valid PR correction, commit/push to the same branch before reviewing that URL again. Never substitute a local summary for the artifact.

## Independent discussion

Use when required by a workflow or for high rework risk: architecture, public contracts, migration, security, concurrency, broad test strategy.

1. Submit a facts-only prompt before writing the agent's implementation opinion.
2. Persist the agent's conclusion in a visible draft before reading Relay.

Then compare shared/agent-only/Relay-only findings, verify repository claims locally, discuss substantive differences, and produce one agent-owned synthesis. Discussion never replaces normal artifact review. Stop with no blocking blind spot, no new substantive argument, or only wording/optional work; allow at most three follow-ups by default. Product/public-contract disagreements follow the active mode's outcome.

## CLI lifecycle

```bash
gpt-relay review --session <task-session-id> --file <prompt-file> --no-wait --json --output <submission.json>
gpt-relay show <task-id> --json --output <task.json>
gpt-relay tasks --session <task-session-id> --last 20 --json --output <tasks.json>
gpt-relay resume --json --output <resume.json>
gpt-relay cancel <task-id>
```

When retaining CLI results, use native `--output <path>` rather than `>`, pipes, or wrapper scripts. All client commands and their controls support it; add `--json` for supported JSON views. It saves exactly stdout while preserving stdout, stderr, and the command's result exit code. Relative paths use the caller's working directory; create the parent directory first. Atomic replacement preserves an existing result on thrown command errors or write failures; complete returned failure results are saved too. File errors exit 1 with `output_write_failed`. Submission may already have happened: retain stdout/stderr task/operation IDs and inspect existing work before retrying. See [full output semantics](./README.md#save-cli-results). Native output avoids shell redirection in command-prefix matching, but approval still depends on the active policies.

Use `--stdin` instead of a file, or omit `--no-wait` to wait. Async acceptance returns `{"taskId":"...","status":"queued"}`. Prefer bounded waits scaled to prompt/review cost and prior duration: roughly 1–2 minutes small, 3–5 ordinary, 5–10 large. Shorten only on concrete completion progress; unchanged observations keep/lengthen intervals. Preserve task ID and do independent work between observations; non-terminal status/wait timeout never justifies resubmission.

Default client wait is 10 minutes; normal task lifetime is 30. `--wait-timeout` changes only the current wait, `--task-timeout` server lifetime. Post-Send lifetime plus active grace enters bounded `recovering`, renewed by strong page evidence. Pending records in `~/.gpt-relay/pending/` support `resume`; reuse `--cri <stable-key>` for retriable same-session calls. Distinct task sessions may run concurrently; one session has at most one active task.

Apply the mode chosen under [client state and sandbox permissions](#client-state-and-sandbox-permissions) throughout this lifecycle. Stateless agents use server-side lookup and `wait` in place of the `resume` example above.

## Diagnose and control an existing session

Use exact task identity with `sessions inspect`, `doctor --session-ref <ref>`, and `tasks trace <task-id>`. Missing/stale/page-DOM observations are unknown evidence. Distinguish `dispatch_disconnected`, `page_snapshot_stale`, `page_snapshot_unknown` and recent explicit `page_probe_failed` using doctor and inspection; none authorizes replay. Unified dispatch uses a single bounded watch and durable claims, with generation recovery against the original task. Manual tabs remain protected unless the user explicitly grants reclamation in the popup; running reviews grants no such permission. The managed limit defaults to 6; safe reclaimable pages may park/reopen, while unavailable capacity leaves work queued. `waiting_for_capacity` in doctor or inspection means retain the original queued task and wait for a safe slot. Do not bypass capacity by duplicating a session or task. See [dispatch and capacity](docs/dispatch.md). Session controls accept either `--session-ref <ref>` or `--session <conversation-id>`.

| Control | Boundary |
|---|---|
| `sessions suspend` / `continue` | Hold/release new claims, preserving active/queued work and running deadlines |
| `tasks recover <id>` | Reattach observation of the original sent active task; never replace uncertain Send |
| `sessions refresh` | Idle clean page, or `--recover-task <id>` for the original active sent task; rejects drafts/ambiguous/unreachable pages |
| `tasks stop <id>` | Request page Stop; inspect both generation state and Relay status. `cancel` stops tracking only |
| `sessions open` | Reuse/reopen a registered conversation without prompt/new conversation; explicit `--instance <id>` selects an installation. Doctor lists instances even with no ChatGPT page; inspect `relayReady` separately |
| `sessions close` | Only idle, clean composer. Preserves queue/session and fences durable suspension; reopen, inspect, explicitly continue to resume queued work |

Blocked/unknown Close can retain suspension: inspect `suspended`, preserve drafts, and never repeatedly close/open an uncertain operation or equate tab closure with stopped generation. Controls cannot launch a closed browser or reload a disabled extension.

Controls return operation IDs immediately, also printed before submission on stderr. Persist and poll with `operations <id>`; after transport loss reuse `--operation-id`, never a fresh ID for unknown outcomes. `queued` is not success; JSON `errorInfo.safeToResubmit: null` is unknown. See [maintenance contracts](api.md#session-maintenance-and-controls).

## Failure handling

| Signal | Action |
|---|---|
| Health fails | Ask user to start `gpt-relay start` |
| Supplied session absent | Ask user to open that conversation/confirm Relay status button |
| Paused/captcha/rate limited | Report `pauseReason`; stop submission, no automatic retry |
| Client wait timeout | Preserve task ID; `show`/`wait`, or ordinary-mode `resume`; no resubmission |
| `recovering` | Original request may complete; observe same task |
| `submissionState: verifying` | Observe through verification deadline; no replay |
| `acknowledged` | Submission observed; continue reply waiting |
| `submission_not_observed` | Concrete send failure; explicit new-task decision, never auto-retry |
| `submission_outcome_unknown` | Ambiguous delivery; inspect the original task with `show`/`wait` or ordinary-mode `resume` before explicit retry decision |
| Attachment upload failure/timeout | Bounded cleanup, no auto-retry; inspect composer if later dispatch misbehaves |
| Failed/cancelled/expired | Report `error`; inspect `show`, or ordinary-mode `resume` only within eligible late-reply window |
| Inaccessible artifact | Supply complete authorized material or request access repair |
| Off-topic reply | Add missing context/confirm session; no substantive round consumed |

Non-terminal `queued`/`in_progress`/`recovering` long-poll results are not failures; recovering work blocks successors. Never bypass with another copy.

`progress.revision`/`changedAt` only schedule observation; advancing `observedAt` alone is unchanged liveness. Provisional activity/phase/output length cannot support review, implementation, quotations, or completion. Final results are terminal `done.reply`, or eligible failed-task `lateReply` with `submissionState: replied`; late success preserves historical `failed` status. See [`task-lifecycle.md`](./task-lifecycle.md).

## Safety and anti-patterns

Prompts/replies persist on the server in `~/.gpt-relay/gpt-relay.db`; ordinary-mode client pending records default to `~/.gpt-relay/pending/`; content goes to the user's ChatGPT session. Never submit unauthorized secrets/sensitive content. Avoid keyword-only approval, concurrent work in one session, summary-only draft review, reading Relay before persisting independent conclusions, discussion after convergence, and dense shell quoting for large/sensitive input.
