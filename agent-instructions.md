# gpt-relay agent guide

Use this guide for relay mechanics. Multi-stage orchestration lives in [`workflows/`](./workflows/README.md); HTTP schemas and environment variables live in [`api.md`](./api.md); the complete state machine lives in [`task-lifecycle.md`](./task-lifecycle.md).

## Core rules

gpt-relay is a local SQLite-backed queue between an agent and the user's signed-in ChatGPT web session. Prefer the root `gpt-relay` CLI at `http://127.0.0.1:8765`; call the HTTP API only for implementation, debugging, or behavior the CLI does not expose.

- Use the task-specific session supplied by the user. Never choose an idle, recent, or previous-task session.
- Reuse that session across every relay phase and round in the task.
- Review remote PRs only after commit, push, and draft-PR publication. The final verdict must apply to the exact pushed head.
- User authorization owns product decisions and final merge. Agent-relay agreement cannot replace it.
- Relay findings are review inputs, not authoritative requirements. The agent owns the evidence-based applicability, scope, and proportionality decision under [`review-convergence.md`](./workflows/review-convergence.md); do not implement a generally useful recommendation mechanically when it is unnecessary for the current project stage or artifact.
- Follow the active workflow's `default` or `auto` mode and its [`review-convergence.md`](./workflows/review-convergence.md) budget. Never add rounds because the mode is `auto`, treat exhausted budget as approval, or ask relay separately whether auto execution may continue.
- On pause, captcha, or explicit rate limiting, stop relay submission and do not retry automatically. Complete independent safe work and follow the active mode's consolidated checkpoint or blocked-handoff rule.

## Preflight and context

```bash
gpt-relay health
gpt-relay sessions
```

Confirm that relay is reachable, the supplied session exists and is not paused, and no unexpected task is in flight for it. If the user did not supply a current-task session ID, request one; do not infer it from the session list.

Assume the session can access user-authorized GitHub URLs and retains the project context already placed in that conversation. Do not resend the README, full repository background, or complete diff every round unless relay cannot access the artifact or clearly misunderstands it. Add complete relevant material when the agent already has it; treat missing authorization, session selection, or sensitive context as a mode-aware blocker.

## Artifact review

For a PR, send the remote URL and exact head:

```text
Act as a strict code reviewer for this PR.

List required changes first. If no blocking issue remains, state that it is safe
to request human review and list remaining risks. Do not promote a general best
practice to a blocker without current applicability evidence.

PR: https://github.com/<owner>/<repo>/pull/<number>
Head: <sha>
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

Different user-supplied sessions may run concurrently; one session processes at most one in-flight task. Never switch sessions merely because another is idle.

## Failure handling

| Signal | Action |
|---|---|
| Health fails | Ask the user to start `gpt-relay start` |
| Supplied session absent | Ask the user to open that conversation and confirm the relay banner |
| Session paused, captcha, or rate limited | Stop submission, report `pauseReason`, and do not retry automatically |
| Client wait times out | Keep `taskId`; use `show` or `resume`; do not resubmit |
| Task is `recovering` | The original ChatGPT request may still complete; keep the task ID, inspect with `show` or `resume`, and do not resubmit |
| `attachment_upload_timeout` or `attachment_upload_failed` | Remove any unfinished attachment from the supplied ChatGPT session; queued successors are preserved and resume after the composer is clean |
| Task failed, cancelled, or expired | Report `error`; use `resume` only when a late-reply window remains |
| Relay cannot access an artifact | Send the complete authorized material or ask the user to fix access |
| Reply is clearly off topic | Add missing context or confirm the session; it is not a substantive review round |

A long poll returning `queued`, `in_progress`, or `recovering` is not failure. A queued successor remains blocked while the original task is recovering; do not bypass that guard by creating another copy. See [`task-lifecycle.md`](./task-lifecycle.md) for recovery evidence and terminal transitions.

## Safety and anti-patterns

Prompts and replies persist in `~/.gpt-relay/gpt-relay.db`; pending records persist in `~/.gpt-relay/pending/`; task content is sent to the user's ChatGPT session. Do not submit unauthorized secrets or sensitive information.

Avoid unpushed PR review, arbitrary session selection, concurrent work in one session, summary-only draft review, approval by keyword matching, automatic retry after pause, reading relay before persisting the supposedly independent agent view, continued discussion after convergence, or dense shell quoting for large or sensitive input.
