# gpt-relay agent guide

This guide explains how an agent should use gpt-relay for reviews, second
opinions, and independent discussion. See [`api.md`](./api.md) for HTTP schemas,
task lifecycle, timeouts, and endpoint details. See
[`workflows/`](./workflows/README.md) for multi-stage issue-to-PR orchestration.

## Overview

gpt-relay is a local SQLite-backed queue. An agent submits a task, the browser
extension executes it in the user's ChatGPT web session, the reply is persisted
locally, and the agent retrieves the result through the CLI or API.

The default relay URL is `http://127.0.0.1:8765`. Prefer the root-level
`gpt-relay` CLI. Call the HTTP API directly only for implementation, debugging,
or behavior that the CLI does not expose.

## Invariants

- **Use the task-specific session supplied by the user.** Never select an idle,
  recent, or previous-task session on the user's behalf.
- **Reuse one session across every relay round in a workflow.** This preserves
  context across issue, plan, implementation, and PR review.
- **Review the remote artifact.** PR review must target a committed and pushed
  remote PR. Do not substitute an unpushed local diff.
- **The user owns product decisions and the final merge decision.** Agent and
  relay agreement does not replace required user authorization.
- **Follow the active workflow's execution mode.** The canonical `default` and
  `auto` definitions live in [`workflows/README.md`](./workflows/README.md).
  Mode controls human checkpoints, not review rigor.
- **Review budgets belong to the active workflow.** Never reset a budget
  automatically, treat budget exhaustion as approval, add review rounds merely
  because the mode is `auto`, or ask relay separately whether auto execution may
  continue.
- **Stop relay submission on pause, captcha, or explicit rate limiting.** Do not
  retry automatically. When a workflow is active, complete independent safe
  work and apply its mode-aware checkpoint or blocked-handoff rule.

## Session assumptions

The relay operates through a ChatGPT session in which the user is already
signed in. Unless evidence shows otherwise, assume that:

- the session can access GitHub issue and PR URLs that the user has authorized,
  including private repositories;
- it has the project vocabulary, architecture, and task context the user placed
  in that conversation;
- every round does not need a copy of the README, full repository background,
  or complete diff.

Degrade only when:

- the relay explicitly cannot access a URL or requests pasted content;
- its reply clearly misunderstands the project or terminology;
- required authorization or private context can only come from the user.

When degrading:

1. If the agent already has the necessary context, include the complete relevant
   material in the next round and explain why.
2. If the missing input is authorization, session selection, or sensitive
   information, stop dependent work and use the active workflow's consolidated
   checkpoint or blocked-handoff rule.

## Preflight

```bash
gpt-relay health
gpt-relay sessions
```

Confirm that:

- the relay is reachable;
- the user-supplied session appears in the list;
- the session is not paused;
- an unexpected task is not already in flight for that session.

If the user has not supplied a session ID for the current task, stop and request
one. Do not choose from the session list.

## What to submit

### GitHub pull requests

First confirm local scope, then commit, push, and create or update the draft PR.
Only perform these writes when the workflow or user authorizes them.

Submit the remote PR URL instead of an inline local diff:

```text
Act as a strict code reviewer for this GitHub draft pull request.

List required changes first. If there are no blocking issues, state explicitly
that it is safe to request human review and list any remaining risks.

PR: https://github.com/<owner>/<repo>/pull/<number>
```

After fixing a valid finding, commit and push it to the same branch, then review
the same PR URL in the same session. The final conclusion must apply to the
latest pushed head.

### GitHub issues

Prefer an accessible issue or placeholder URL. If no remote artifact exists,
submit the complete draft rather than a summary:

```text
Act as a strict product and engineering reviewer for the following issue draft.

Check scope, non-goals, acceptance criteria, dependencies, risks, compatibility,
and executability. List findings by severity. If no blocking issue remains,
state explicitly that the issue can proceed.

--- issue draft ---
<complete text>
```

Number multiple drafts and give each a clear title.

### Other text

Submit the complete design document, prompt, commit message, or other independent
text. For long input, use `--file` or stdin instead of embedding it in a densely
quoted shell command.

## Independent discussion mode

When a workflow requires it, or when an implementation path has a high cost of
rework, the agent and relay can analyze the problem independently before
synthesis. Typical cases include scope discovery, architecture, public
contracts, migrations, security, concurrency, and test coverage.

### Two barriers

1. **Before submitting to relay, the agent must not write its implementation
   opinion.** The initial prompt contains only the task, URLs, and objective
   constraints.
2. **Before reading the relay reply, the agent must write its own conclusion to
   a visible draft.** Keeping it only in hidden reasoning does not satisfy the
   barrier.

After those barriers are in place:

1. Submit a facts-only prompt with `--no-wait` and save the `taskId`.
2. Independently inspect the repository and write the agent analysis or plan.
3. After the draft is saved, read the relay reply with
   `gpt-relay show <taskId>` or an API long poll.
4. Compare shared findings, agent-only findings, relay-only findings, and
   substantive disagreements.
5. Discuss only important differences, then produce an agent-owned synthesis.

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
gpt-relay show <task-id>
```

Parallel discovery does not replace artifact review. The resulting issue body,
implementation plan, or PR still passes through its normal review gate.

### Termination conditions

- No blocking decision or important blind spot remains.
- Another round adds no substantive argument.
- Remaining differences are wording, style, or optional follow-up work.
- By default, stop after at most three follow-up rounds.

If a substantive disagreement remains about product behavior, policy, UX,
public contracts, or scope, stop dependent work. Without an active workflow,
present both rationales to the user; with one, apply its mode-aware consolidated
checkpoint or blocked-handoff rule.

### When not to use parallel discovery

- Facts and context must be aligned sequentially first.
- The workflow intentionally has the agent create an artifact before relay
  reviews it.
- The change is narrow, the path is clear, and rework cost is low.

## CLI operations

### Submit and wait

```bash
gpt-relay review --session <task-session-id> --stdin
gpt-relay review --session <task-session-id> --file <prompt-file>
```

The default client wait is 10 minutes and the default task lifetime is
30 minutes. `--wait-timeout` affects only the current CLI wait;
`--task-timeout` changes the server-side task deadline. See
[`api.md`](./api.md#timeouts-and-late-replies).

### Submit without waiting

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
```

The command prints machine-readable JSON:

```json
{"taskId":"...","status":"queued"}
```

### Inspect, recover, and cancel

```bash
gpt-relay tasks --session <task-session-id> --last 20
gpt-relay show <task-id>
gpt-relay resume
gpt-relay cancel <task-id>
```

The CLI records unfinished tasks under `~/.gpt-relay/pending/`. After an agent
or shell interruption, use `gpt-relay resume` instead of submitting a duplicate
task.

Calls that may be retried should pass `--cri <stable-key>`. Reusing the same key
in the same session returns the original task.

## Concurrent sessions

Different tasks can run concurrently in different user-supplied sessions. A
single session processes at most one in-flight task at a time.

Do not:

- submit concurrent current-task work to one session;
- switch a workflow merely because another session is idle;
- change sessions between phases of one workflow.

## Failure handling

| Signal | Agent action |
|---|---|
| `gpt-relay health` fails | Ask the user to start `gpt-relay start` |
| Supplied session is absent | Ask the user to open that ChatGPT conversation and confirm the relay banner |
| Session is paused, captcha, or rate limited | Stop and report `pauseReason` |
| Client wait times out | Keep `taskId`; use `resume` or `show`; do not resubmit |
| Task is `failed`, `cancelled`, or `expired` | Report `error`; use `resume` later if a late-reply window remains |
| Relay cannot access a URL | Include the complete necessary text or ask the user to resolve access |
| Reply is clearly off topic | Stop the review and add context or ask the user to confirm the session |

A single HTTP long poll returning `queued` or `in_progress` does not mean the
task failed. See [`api.md`](./api.md) for lifecycle and late-reply rules.

## Anti-patterns

- Reviewing an inline, unpushed local diff as if it were the PR.
- Selecting an idle or recent session without user direction.
- Repeating the complete repository context in every round.
- Sending only a summary or selected excerpts of a draft.
- Deciding review approval through keyword matching.
- Automatically retrying after relay pause.
- Writing the supposed independent agent conclusion after reading relay output.
- Continuing discussion after blocking blind spots are resolved.
- Treating agent and relay agreement as a user decision.
- Passing large or sensitive text through dense shell quoting or shell history.

## Data and privacy

Prompts and replies are persisted in `~/.gpt-relay/gpt-relay.db`. Pending task
records are stored in `~/.gpt-relay/pending/`. Task content is sent to the
user's ChatGPT web session.

Do not submit credentials, secrets, or sensitive information that the user has
not authorized for sharing with ChatGPT.

## Related documentation

- [`api.md`](./api.md): HTTP API, task lifecycle, timeouts, and environment
  variables
- [`workflows/README.md`](./workflows/README.md): multi-stage orchestration entry
  points
- [`README.md`](./README.md): installation, CLI, and extension overview
- [`extension/README.md`](./extension/README.md): browser extension setup and
  recovery behavior
