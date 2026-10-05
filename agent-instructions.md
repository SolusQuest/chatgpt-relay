# gpt-relay agent guide

## Diagnose and control an existing session

Start with `gpt-relay sessions inspect --session-ref <ref>`, `gpt-relay doctor --session-ref <ref>`, and `gpt-relay tasks trace <task-id>`. Use the current task's exact session identity. Missing/stale observations and absent message DOM are unknown evidence.

Use `sessions suspend` / `sessions continue` with the same session flag to hold/release new claims without cancelling existing work. Deadlines continue to run. Use `tasks recover <task-id>` to observe the original sent active task again; never replace an uncertain send with a new review request.

Use `sessions refresh --session-ref <ref>` for an idle clean page, or add `--recover-task <task-id>` to preserve observation of an active sent task. It refuses drafts and ambiguous or unreachable pages. Use `tasks stop <task-id>` for the page's Stop button; `cancel` only cancels Relay tracking. Read both page generation and Relay task status in the Stop result.

Control commands return an operation ID immediately. Poll `gpt-relay operations <operation-id>` for the result. Persist the ID (also printed before submission on stderr) and reuse it with `--operation-id` after transport failure. `queued` is not success, and `unknown` must not trigger a blind retry with a new ID. These commands and their errors use JSON. Structured `errorInfo.safeToResubmit: null` means unknown. See [API maintenance contracts](api.md#session-maintenance-and-controls) for details.

Use this guide for relay mechanics. Multi-stage orchestration lives in [`workflows/`](./workflows/README.md); HTTP schemas and environment variables live in [`api.md`](./api.md); the complete state machine lives in [`task-lifecycle.md`](./task-lifecycle.md).

## Core rules

gpt-relay is a local SQLite-backed queue between an agent and the user's signed-in ChatGPT web session. Prefer the root `gpt-relay` CLI at `http://127.0.0.1:8765`; call the HTTP API only for implementation, debugging, or behavior the CLI does not expose.

- Use the task-specific session supplied by the user or already established for this execution chain. When none exists, follow the workflow's [mode-aware session selection](./workflows/README.md#relay-session-selection): ask early in `default`, create and notify without a confirmation checkpoint in `auto`. An explicit request for a new session already authorizes creation. Never choose an idle, recent, or previous-task session.
- Reuse that session across every relay phase and round in the task, including delegated stages. Consume the shared [stage handoff](./workflows/README.md#stage-handoffs-and-delegation) and preserve artifact revisions, authority, ledgers, review budgets, and original task IDs when another agent continues the execution chain.
- Review remote PRs only after commit, push, and draft-PR publication. The final verdict must apply to the exact pushed head.
- Use the active workflow's submission policy. The PR workflow [defaults to parallel CI and relay review, with evidence-based waiting](./workflows/implementation.md#review-submission-and-ci-scheduling); disclose passed and pending validation in the prompt. A relay verdict does not replace the workflow's final CI and handoff gates.
- User authorization owns product decisions and final merge. Agent-relay agreement cannot replace it.
- Relay findings are review inputs, not authoritative requirements. The agent owns the evidence-based applicability, scope, proportionality, and [problem-level remediation](./workflows/review-convergence.md#problem-level-remediation) decision under [`review-convergence.md`](./workflows/review-convergence.md); do not patch the literal comment or implement a generally useful recommendation mechanically when it is unnecessary for the current project stage or artifact.
- Follow the active workflow's `default` or `auto` mode and its [`review-convergence.md`](./workflows/review-convergence.md) budget. Never add rounds because the mode is `auto`, treat exhausted budget as approval, or ask relay separately whether auto execution may continue.
- On pause, captcha, or explicit rate limiting, stop relay submission and do not retry automatically. Complete independent safe work and follow the active mode's consolidated checkpoint or blocked-handoff rule.

## Preflight and context

```bash
gpt-relay health
gpt-relay sessions
```

Resolve session selection at invocation preflight using the shared workflow rule. For an existing conversation, confirm that relay is reachable, the selected session exists and is not paused, and no unexpected task is in flight for it. When no task-specific session is supplied or already established, `default` asks whether to create or use a supplied session while continuing independent safe work; `auto` proceeds to creation without an approval question. A missing or paused supplied session is an execution blocker, not permission to substitute another session.

### New-session mode

Honor an explicit Project selection; otherwise query the local catalog and choose an appropriate `projectId` from task context, names and descriptions. With no appropriate Project, explicitly use `--no-project` unless the user requires a particular Project. Resolve Project names to IDs for the CLI. Generate and persist an agent-owned `sessionRef` such as `sr_<uuid>` before submission, and submit the first substantive workflow prompt as part of creation:

```bash
gpt-relay projects --json
gpt-relay review --new-session --session-ref <ref> --project-id <project-id> --file <prompt-file> --no-wait
gpt-relay sessions --session-ref <ref> --json
gpt-relay show <task-id>
gpt-relay review --session-ref <ref> --file <follow-up-file> --no-wait
```

Use `--no-project` instead of `--project-id` to explicitly create an ordinary chat. Creation requires a ref, a nonempty first message and exactly one Project choice. `--text`, `--stdin`, wait options and task deadlines work as for existing conversations. Old `--session <id>` calls remain supported; do not provide both selectors.

After acceptance, retain the first task ID and tell the user that creation was requested, identifying the ref and Project choice. Report successful creation only after `creationStatus` is `created` and the conversation ID is bound. In `auto`, neither notification is a permission checkpoint: continue independent work during creation and use the same ref for subsequent Relay phases. Required Relay results still gate dependent work. Do not create another session on workflow composition, fallback or resume, or use an initialization placeholder that bypasses the independent-discussion barriers.

A Project supplies its configured basic context. The first message must add the current goal, scope, repository/material URLs, relevant revision and necessary evidence. When instructions call for reading repository `AGENTS.md`, identify its source and supply relevant content if it cannot be accessed. Do not assume a new chat inherits all messages from an earlier chat.

Creation retries with the same ref and effective parameters return the original first task. Changed parameters conflict. Use the same ref throughout the task; after a confirmed creation failure, a fresh creation needs a fresh ref. `created` means the conversation ID was bound, even if the first task failed. `pending` or `unknown` without an ID is not permission to open another page and replay the prompt. Wait for recovery evidence. A created session may still be paused, generating or temporarily unavailable.

The CLI/client generates a `clientRequestId` for each message and saves its identity before submission. Use `resume` to find an accepted task after a lost response; an unconfirmed record is retained without resubmission. An independently repeated CLI command generates a new key, so it is a new message unless the original `--cri` is explicitly reused. The request key protects server acceptance; the browser Send fence separately prevents prompt replay.

Maintain the local catalog with:

```bash
gpt-relay projects set --project-id <project-id> --name "Project name" --description "Purpose and basic context"
gpt-relay projects remove --project-id <project-id>
```

Catalog writes affect local metadata only. Omitted descriptions are preserved; an empty description clears its text. Names help selection, but creation uses the ID. The catalog is not an access guarantee or an allowlist: a valid directly supplied ID is accepted and the extension verifies the page before sending. `gpt-relay projects discover` previews visible Project links in open ChatGPT tabs; `--save` merges observed names by ID and preserves descriptions and unseen entries. The JSON result includes source pages and `complete: false`: collapsed or unloaded projects may be missing. Conflicting observed names are reported and skipped. `--no-wait` returns a discovery ID for later API polling. Discovery never sends chat messages or switches tabs.

Assume an existing session can access user-authorized GitHub URLs and retains the project context already placed in that conversation. Do not resend the README, full repository background, or complete diff every round unless relay cannot access the artifact or clearly misunderstands it. Add complete relevant material when the agent already has it; treat missing authorization, session selection, or sensitive context as a mode-aware blocker.

## Artifact review

For a PR, send the remote URL, exact head, and current validation evidence:

```text
Act as a strict code reviewer for this PR.

List required changes first. If no blocking issue remains in the reviewed code and available evidence, state that and list remaining risks. Do not promote a general best practice to a blocker without current applicability evidence.
Pending checks are unverified. If missing evidence prevents a review conclusion, identify the specific necessary proof; do not infer a code failure merely from ordinary pending CI. The workflow owns final readiness after its required checks and feedback gates complete.

PR: https://github.com/<owner>/<repo>/pull/<number>
Head: <sha>
Validation passed: <checks, target-path execution, and evidence references>
Validation pending: <checks or execution proof still outstanding>
```

For an unpublished issue, send the complete draft rather than a summary:

```text
Act as a strict product and engineering reviewer for this issue draft.

Check scope, non-goals, acceptance criteria, dependencies, risks,
compatibility, and executability. Separate blockers from optional work, and
challenge unnecessary release-grade requirements with a simpler sufficient
alternative.

--- issue draft ---
<complete text>
```

Use `--file` or stdin for long text. After fixing a valid PR finding, commit and push to the same branch before reviewing the same PR URL again. Artifact-specific prompts and convergence verdicts belong to the active workflow.

## Independent discussion

Use independent discussion only when a workflow requires it or rework risk is high, such as architecture, public contracts, migrations, security, concurrency, or broad test coverage.

Two barriers preserve independence:

1. Submit a facts-only relay prompt before the agent writes its implementation opinion.
2. Persist the agent's own conclusion to a visible draft before reading relay's reply.

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
gpt-relay show <task-id>
```

After both barriers, compare shared, agent-only, and relay-only findings; verify relay repository claims locally; discuss only substantive differences; and produce one agent-owned synthesis. Independent discussion never replaces the artifact's normal review gate.

Stop when no blocking blind spot remains, another round adds no substantive argument, or only wording and optional follow-ups differ. Use at most three follow-up rounds by default. A remaining product or public-contract disagreement follows the active workflow's consolidated checkpoint or blocked-handoff rule.

## CLI lifecycle

Submit and wait:

```bash
gpt-relay review --session <task-session-id> --stdin
gpt-relay review --session <task-session-id> --file <prompt-file>
```

Submit asynchronously:

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
```

The asynchronous result is `{"taskId":"...","status":"queued"}`. Inspect and recover with:

```bash
gpt-relay tasks --session <task-session-id> --last 20
gpt-relay show <task-id>
gpt-relay resume
gpt-relay cancel <task-id>
```

Prefer bounded long waits over frequent status checks. Choose the next observation interval from the expected review cost, prompt size, prior duration in the same session, and any concrete progress signal. As a starting point, use roughly 1-2 minutes for a small request, 3-5 minutes for an ordinary review, and 5-10 minutes for a large review or long-context analysis. Shorten the interval only when observed progress suggests completion may be near; after unchanged observations, keep or lengthen it rather than polling more frequently. A wait timeout or non-terminal status is not a reason to resubmit. Preserve the original task ID and perform independent local work between observations when possible.

The client waits 10 minutes by default and the normal task lifetime is 30 minutes by default. A page-submitted task that crosses that lifetime plus active-task grace becomes non-terminal `recovering`; the extension can maintain it with strong page evidence until its bounded recovery deadline. `--wait-timeout` changes only the current CLI wait; `--task-timeout` changes the normal server lifetime. Pending records under `~/.gpt-relay/pending/` let `resume` recover without duplicate submission. Retriable calls should use `--cri <stable-key>` for same-session idempotency.

Different task-specific sessions may run concurrently; one session processes at most one in-flight task. Never switch sessions merely because another is idle.

## Failure handling

| Signal | Action |
|---|---|
| Health fails | Ask the user to start `gpt-relay start` |
| Supplied session absent | Ask the user to open that conversation and confirm the relay banner |
| Session paused, captcha, or rate limited | Stop submission, report `pauseReason`, and do not retry automatically |
| Client wait times out | Keep `taskId`; use `show` or `resume`; do not resubmit |
| Task is `recovering` | The original ChatGPT request may still complete; keep the task ID, inspect with `show` or `resume`, and do not resubmit |
| `submissionState` is `verifying` | Observe the same task through `submissionVerificationDeadlineAt`; do not resubmit during verification |
| `submissionState` is `acknowledged` | The original submission was observed; continue normal reply waiting |
| `submission_not_observed` | Treat as a concrete send failure and decide explicitly whether to create a new task; never auto-retry |
| `submission_outcome_unknown` | Submission remains ambiguous; inspect `show`/`resume` and make an explicit retry decision |
| `attachment_upload_timeout` or `attachment_upload_failed` | The extension attempts bounded cleanup and does not auto-retry; inspect the composer if the next dispatch behaves unexpectedly |
| Task failed, cancelled, or expired | Report `error`; use `resume` only when a late-reply window remains |
| Relay cannot access an artifact | Send the complete authorized material or ask the user to fix access |
| Reply is clearly off topic | Add missing context or confirm the session; it is not a substantive review round |

A long poll returning `queued`, `in_progress`, or `recovering` is not failure. A queued successor remains blocked while the original task is recovering; do not bypass that guard by creating another copy. See [`task-lifecycle.md`](./task-lifecycle.md) for recovery evidence and terminal transitions.

An active task may expose an in-memory `progress` snapshot. Treat `revision` and
`changedAt` only as observation-scheduling hints: continued changes can justify
a nearer check, while only `observedAt` advancing means the page is still active
but visibly unchanged. `activity`, `phase`, and `outputChars` are provisional;
never review, implement, quote, or make a completion decision from them. Only a
terminal `done` task and its `reply` are final. For an eligible failed task,
`lateReply` is an effective successful result even though the historical task
status remains `failed`; `submissionState` will be `replied`.

## Safety and anti-patterns

Prompts and replies persist in `~/.gpt-relay/gpt-relay.db`; pending records persist in `~/.gpt-relay/pending/`; task content is sent to the user's ChatGPT session. Do not submit unauthorized secrets or sensitive information.

Avoid unpushed PR review, arbitrary session selection, concurrent work in one session, summary-only draft review, approval by keyword matching, automatic retry after pause, reading relay before persisting the supposedly independent agent view, continued discussion after convergence, or dense shell quoting for large or sensitive input.
