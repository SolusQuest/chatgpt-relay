# gpt-relay agent guide

gpt-relay connects an agent to the user's signed-in ChatGPT through a local SQLite queue. Prefer the root `gpt-relay` CLI (`http://127.0.0.1:8765`); use HTTP for implementation/debugging or behavior the CLI lacks. [Workflows](./workflows/README.md) own orchestration, [`api.md`](./api.md) owns HTTP/environment details, and [`task-lifecycle.md`](./task-lifecycle.md) owns the full state machine.

## Core rules

- Use the supplied/established task session across phases, rounds, delegation, and resume. Resolve missing identity at preflight under [session selection](./workflows/README.md#relay-session-selection); never pick an idle/recent/previous-task session. Preserve shared [handoff](./workflows/README.md#stage-handoffs-and-delegation) revisions, authority, ledgers, budgets, and original task IDs.
- PR review requires commit, push, remote draft PR, and exact pushed head. Apply [submission scheduling](./workflows/implementation.md#review-submission-and-ci-scheduling), disclose passed/pending proof, and satisfy final CI/handoff gates separately.
- User authority owns product decisions/merge. Relay findings are inputs; the agent verifies applicability and the underlying problem under [`review-convergence.md`](./workflows/review-convergence.md), rather than mechanically implementing comments or best practices.
- Mode changes checkpoints, never budget/rigor. Exhaustion is not approval; do not ask Relay separately whether `auto` may continue.
- Pause, captcha, or explicit rate limiting stops submission without automatic retry. Complete independent safe work, then use the active mode's consolidated checkpoint/blocked outcome.

## Preflight and context

```bash
gpt-relay health
gpt-relay sessions
gpt-relay sessions inspect --session-ref <ref>
```

Resolve/inherit identity before substantial work. Confirm reachability, selected session availability, no pause, and no unexpected active task. An absent/paused supplied session blocks execution, not permission to substitute. See **New-session mode** only when creation is needed; [diagnostics/controls](#diagnose-and-control-an-existing-session) and catalog maintenance are otherwise conditional.

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

CLI/client persists `clientRequestId` before each message. After a lost response, `resume` observes accepted work and retains unmatched records without resubmission. Repeating a command generates a new key/message unless `--cri` is explicitly reused. Request idempotency and the browser Send fence are separate protections.

**Catalog maintenance — only when needed:** `projects set --project-id <id> --name <name> [--description <text>]` and `projects remove --project-id <id>` change local metadata only. Omitted descriptions persist; empty text clears them. Names aid selection, but creation uses IDs. Catalog entries neither guarantee access nor form an allowlist; valid supplied IDs work with page verification. `projects discover [--save] [--no-wait]` reads visible links in open tabs without messages, navigation, or tab switching. Results include sources and `complete: false`; collapsed/unloaded Projects may be absent. Save merges names by ID, preserving descriptions/unseen entries and skipping conflicting observed names. Async discovery returns an ID for API polling.

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
gpt-relay review --session <task-session-id> --file <prompt-file> --no-wait
gpt-relay show <task-id>
gpt-relay tasks --session <task-session-id> --last 20
gpt-relay resume
gpt-relay cancel <task-id>
```

Use `--stdin` instead of a file, or omit `--no-wait` to wait. Async acceptance returns `{"taskId":"...","status":"queued"}`. Prefer bounded waits scaled to prompt/review cost and prior duration: roughly 1–2 minutes small, 3–5 ordinary, 5–10 large. Shorten only on concrete completion progress; unchanged observations keep/lengthen intervals. Preserve task ID and do independent work between observations; non-terminal status/wait timeout never justifies resubmission.

Default client wait is 10 minutes; normal task lifetime is 30. `--wait-timeout` changes only the current wait, `--task-timeout` server lifetime. Post-Send lifetime plus active grace enters bounded `recovering`, renewed by strong page evidence. Pending records in `~/.gpt-relay/pending/` support `resume`; reuse `--cri <stable-key>` for retriable same-session calls. Distinct task sessions may run concurrently; one session has at most one active task.

## Diagnose and control an existing session

Use exact task identity with `sessions inspect`, `doctor --session-ref <ref>`, and `tasks trace <task-id>`. Missing/stale/page-DOM observations are unknown evidence. Session controls accept either `--session-ref <ref>` or `--session <conversation-id>`.

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
| Supplied session absent | Ask user to open that conversation/confirm Relay banner |
| Paused/captcha/rate limited | Report `pauseReason`; stop submission, no automatic retry |
| Client wait timeout | Preserve task ID; `show`/`resume`, no resubmission |
| `recovering` | Original request may complete; observe same task |
| `submissionState: verifying` | Observe through verification deadline; no replay |
| `acknowledged` | Submission observed; continue reply waiting |
| `submission_not_observed` | Concrete send failure; explicit new-task decision, never auto-retry |
| `submission_outcome_unknown` | Ambiguous delivery; inspect `show`/`resume` before explicit retry decision |
| Attachment upload failure/timeout | Bounded cleanup, no auto-retry; inspect composer if later dispatch misbehaves |
| Failed/cancelled/expired | Report `error`; use `resume` only within eligible late-reply window |
| Inaccessible artifact | Supply complete authorized material or request access repair |
| Off-topic reply | Add missing context/confirm session; no substantive round consumed |

Non-terminal `queued`/`in_progress`/`recovering` long-poll results are not failures; recovering work blocks successors. Never bypass with another copy.

`progress.revision`/`changedAt` only schedule observation; advancing `observedAt` alone is unchanged liveness. Provisional activity/phase/output length cannot support review, implementation, quotations, or completion. Final results are terminal `done.reply`, or eligible failed-task `lateReply` with `submissionState: replied`; late success preserves historical `failed` status. See [`task-lifecycle.md`](./task-lifecycle.md).

## Safety and anti-patterns

Prompts/replies persist in `~/.gpt-relay/gpt-relay.db`; pending records in `~/.gpt-relay/pending/`; content goes to the user's ChatGPT session. Never submit unauthorized secrets/sensitive content. Avoid keyword-only approval, concurrent work in one session, summary-only draft review, reading Relay before persisting independent conclusions, discussion after convergence, and dense shell quoting for large/sensitive input.
