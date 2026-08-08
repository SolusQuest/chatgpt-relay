# gpt-relay API reference

This document is the authoritative reference for the gpt-relay HTTP protocol.
See [`agent-instructions.md`](./agent-instructions.md) for everyday agent review
operations and [`README.md`](./README.md) for installation and CLI usage.

## Conventions

- Default base URL: `http://127.0.0.1:8765`
- Clients can override it with `GPT_RELAY_URL`.
- The server bind address and port use `GPT_RELAY_HOST` and `GPT_RELAY_PORT`.
- JSON endpoints use `application/json`.
- All timestamps are Unix epoch milliseconds.
- The public agent API uses `/v1/*`.
- `/internal/*` is reserved for the browser extension and is not a stable agent
  integration surface.

## Task status

| Status | Meaning |
|---|---|
| `queued` | Waiting for the extension to claim the task |
| `in_progress` | Claimed and running in the ChatGPT page |
| `recovering` | The normal task lifetime passed after Send; the extension is still observing the original page request |
| `done` | Completed successfully; `reply` contains the final output |
| `failed` | Failed; `error` contains the reason |
| `cancelled` | Cancelled by the agent or page user |
| `expired` | Passed its deadline before being claimed |

`queued`, `in_progress`, and `recovering` are non-terminal. `done`, `failed`,
`cancelled`, and `expired` are terminal. A reply captured while a task is
`recovering` completes it normally and is stored in `reply`. A result discovered
after an eligible terminal failure is stored in `lateReply`; it does not change
the terminal status back to `done`.

## Task object

```jsonc
{
  "taskId": "<task-id>",
  "session": "<session-id>",
  "clientRequestId": null,
  "status": "done",
  "text": "original prompt",
  "reply": "final reply",
  "lateReply": null,
  "error": null,
  "timeoutMs": 1800000,
  "submittedAt": 1783846951352,
  "dispatchedAt": 1783846986252,
  "completedAt": 1783847074944,
  "lateCompletedAt": null,
  "submitStartedAt": 1783846986255,
  "sendAttemptedAt": 1783846987000,
  "submitAcknowledgedAt": 1783846987312,
  "generatingSeenAt": 1783846989344,
  "replyDetectedAt": 1783847074200,
  "recoveryStartedAt": null,
  "recoveryObservedAt": null,
  "recoveryReason": null,
  "expiresAt": 1783848751352,
  "completionDeadlineAt": 1783848811352,
  "recoveryLeaseDeadlineAt": null,
  "recoveryDeadlineAt": 1783850611352,
  "lateReplyDeadlineAt": 1783850611352,
  "requeueCount": 0,
  "progress": null
}
```

`text` is returned only by a single-task query or when a list request includes
`include_text=1`.

While a task is active, `progress` can contain the latest provisional page
observation:

```jsonc
{
  "revision": 1783847012000,
  "phase": "answer_streaming",
  "activity": "Reading files",
  "outputChars": 1830,
  "observedAt": 1783847012000,
  "changedAt": 1783847012000,
  "provisional": true
}
```

`phase` is `accepted`, `generating`, or `answer_streaming`. `activity` is an
optional, bounded status label that was visibly exposed by the page;
`outputChars` is only a size signal and is not partial reply content.
`observedAt` advances on a bounded heartbeat, while `changedAt` and `revision`
advance only when the visible phase, activity, or output size changes.

Progress is held only in server memory, expires after two minutes without an
observation, and is cleared at a terminal transition. It is not written to
SQLite and disappears across a server restart. The extension recreates it on a
later observation if the task is still active. Clients must never treat
progress as a reply, a completion verdict, recovery evidence, or authorization
to act on unfinished output.

### Stable task errors

The relay and extension use stable machine-readable codes for expected
lifecycle failures:

| Code | Meaning |
|---|---|
| `task_expired_before_dispatch` | A queued task crossed its deadline before the extension claimed it |
| `task_processing_timeout` | A claimed task crossed its soft deadline before the durable Send fence was recorded |
| `submission_outcome_unknown` | Send may have been attempted, but the extension could not confirm submission before the deadline or before safely advancing queued work |
| `task_recovery_lease_expired` | A recovering task stopped receiving strong page observations |
| `task_recovery_timeout` | A recovering task reached its absolute recovery deadline |
| `session_heartbeat_lost` | The relay released an active task after its browser session became stale |
| `aborted` | The extension task wait was aborted |
| `attachment_upload_timeout` | A large pasted-text attachment did not enable Send within 90 seconds |
| `attachment_upload_failed` | ChatGPT exposed an attachment upload failure before Send |

Unexpected extension failures can still include a descriptive `error` string.
Clients must use `status` to identify terminal tasks and should display unknown
error values rather than rejecting them.

## Public API

### `POST /v1/tasks`

Submit a task.

Request:

```jsonc
{
  "session": "<task-specific-session-id>",
  "text": "<complete prompt>",
  "timeout": 1800000,
  "clientRequestId": "stable-idempotency-key"
}
```

Fields:

- `session`: required, non-empty, at most 128 characters.
- `text`: required, non-empty, 512 KiB by default.
- `timeout`: optional server-side task lifetime before active-task grace; 30
  minutes by default and capped at 60 minutes. A page-submitted task can remain
  non-terminal in bounded recovery after this lifetime.
- `clientRequestId`: optional; forms an idempotency key with `session`.

Successful `201` response:

```json
{
  "taskId": "...",
  "status": "queued"
}
```

Suspicious input encoding can add:

- `encodingWarning`: the input may be ASCII-lossy; the task is still accepted.
- `encodingFixed`: the server repaired recognizable mojibake.

Common errors:

| HTTP | `error` | Condition |
|---|---|---|
| `400` | `invalid session` | Session is missing or invalid |
| `400` | `missing text` | Text is empty |
| `409` | `session_paused` | Session is paused |
| `413` | `task_too_large` | Prompt exceeds the configured size |
| `429` | `queue_full` | Session queue reached its limit |

### `GET /v1/tasks/:id`

Read a complete task.

Optional query:

- `wait=<ms>`: server-side long poll, capped at 60,000 ms.
- `progress_after=<revision>`: additionally return when a newer in-memory
  progress revision is available. Reuse the latest returned revision as the
  next cursor. The value must be a non-negative safe integer.

When the task becomes terminal, the long poll returns immediately. If the poll
ends while the task is still running, it returns the current `queued`,
`in_progress`, or `recovering` state; that response is not an error.

Without `progress_after`, provisional observations do not end the long poll.
An unchanged observation updates `observedAt` but does not create a revision or
wake a progress-aware long poll.

`404` means the task does not exist or has been cleaned up.

### `DELETE /v1/tasks/:id`

Cancel a task:

- `queued` becomes `cancelled` immediately.
- `in_progress` becomes `cancelled`; current page generation may still consume
  resources, but it is not stored as a normal reply.
- `recovering` becomes `cancelled` for the same reason. Cancellation is an
  explicit terminal user/agent decision; it is not reported as a timeout.
- a terminal task returns `409 invalid_transition`.

The response is a Task object without `text`.

### `GET /v1/tasks`

List tasks.

Queries:

- `session=<id>`
- `status=queued,done`
- `since=<epoch-ms>`
- `limit=<positive-int>`
- `include_text=1`

Response:

```json
{
  "tasks": []
}
```

Invalid status values are ignored. The default limit is 50, with a minimum of 1
and maximum of 500.

### `GET /v1/sessions`

List active sessions:

```jsonc
{
  "sessions": [
    {
      "session": "<session-id>",
      "lastSeen": 1783852452632,
      "lastStatusAt": 1783852452628,
      "paused": false,
      "pauseReason": null,
      "pausedAt": null,
      "pendingTasks": 0,
      "inProgressTaskId": null,
      "activeTaskId": null,
      "activeTaskStatus": null
    }
  ]
}
```

`inProgressTaskId` is retained as a compatibility alias and can identify either
active status. New clients should use `activeTaskId` and `activeTaskStatus`. An
empty array means that no ChatGPT tabs are currently active.

### `POST /v1/sessions/:id/pause`

Pause a session manually:

```json
{
  "reason": "manual pause"
}
```

Pausing blocks new tasks and fails all queued, in-progress, and recovering tasks
in that session.

### `POST /v1/sessions/:id/resume`

Resume a session. The request has no body.

### `GET /health`

```json
{
  "status": "ok",
  "sessions": 2
}
```

`sessions` is the number of currently active sessions. It does not imply that
every session is unpaused or available.

## Extension-internal API

The following endpoints are mounted under `/internal` and are used only by the
MV3 extension. Agents should use `/v1` or the root CLI.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/internal/next_task?session=&wait=` | Heartbeat, long-poll, and claim the next queued task; wait is capped at 25 seconds |
| `POST` | `/internal/tasks/:id/capture` | Capture a DOM reply, including a possible late reply |
| `POST` | `/internal/tasks/:id/progress` | Record a page lifecycle phase |
| `POST` | `/internal/tasks/:id/observation` | Replace the latest in-memory provisional page observation |
| `POST` | `/internal/tasks/:id/complete` | Complete or fail a task |
| `POST` | `/internal/tasks/:id/user-stop` | Cancel after the page user selects Stop |
| `POST` | `/internal/tasks/:id/recover` | Recover a DOM reply after page or extension restart |
| `POST` | `/internal/tasks/:id/defer` | Return a newly claimed, pre-send task to the queue when the page is busy |
| `POST` | `/internal/tasks/:id/requeue` | Requeue a proven pre-send task and increment its counter |
| `POST` | `/internal/heartbeat` | Update the session heartbeat |
| `POST` | `/internal/sessions/:id/status` | Report pause, resume, and reason |

Progress phases:

- `submit_started`
- `send_attempted`
- `submit_acknowledged`
- `generating_seen`
- `recovery_observed`
- `reply_detected`

The separate observation endpoint accepts `phase`, optional `activity`, and
optional `outputChars`. It never accepts partial reply text and never writes to
the task database. The extension reports semantic changes at most once per 10
seconds and unchanged liveness at most once per 30 seconds.

`POST /internal/sessions/:id/status` accepts extension-only
`preserveQueued: true` for a pre-send attachment-cleanup block. The session is
paused and active work is failed, but already queued successors remain queued
until the extension confirms that the composer is clean and resumes the
session. Public pause requests retain their existing fail-all behavior.

The detailed internal request and response contracts are defined by
[`server/routes/internal.ts`](./server/routes/internal.ts) and the extension
integration tests.

## Task lifecycle

```text
queued
  |-- claim ------------------------------> in_progress
  |-- cancel -----------------------------> cancelled
  `-- deadline before claim --------------> expired

in_progress
  |-- capture/complete success ----------------> done
  |-- soft deadline before send_attempted ------> failed
  |-- soft deadline after send_attempted -------> recovering
  |-- complete error ----------------------------> failed
  |-- cancel/user-stop --------------------------> cancelled
  `-- defer/requeue before send_attempted -------> queued

recovering
  |-- capture/recover reply ---------------------> done
  |-- cancel/user-stop --------------------------> cancelled
  |-- session heartbeat lost --------------------> failed
  |-- recovery lease expires --------------------> failed
  `-- absolute recovery deadline ----------------> failed

eligible terminal failure
  `-- late DOM result before recoveryDeadlineAt -> lateReply (status unchanged)
```

Each session can have at most one active (`in_progress` or `recovering`) task.
`recovering` therefore blocks queued successors from being claimed. Queued tasks
are otherwise claimed in submission order.

`send_attempted` is a durable at-most-once fence. After that phase is recorded, `defer` and `requeue` return `400 unsafe_retry_after_send_attempt`; clients must create an explicit new task if a human chooses to retry.

The complete state and evidence model is documented in
[`task-lifecycle.md`](./task-lifecycle.md).

## Timeouts, recovery, and late replies

Keep four time dimensions separate:

1. **Client wait timeout**: how long the CLI or agent client waits in the
   current call. It does not alter task state.
2. **Task lifetime**: the wall-clock deadline from `submittedAt`, represented by
   `expiresAt`. For an active task, `activeTaskGraceMs` extends this to the soft
   `completionDeadlineAt`.
3. **Recovery lease**: after Send and the soft deadline, strong page evidence
   renews a short lease. Its current bound is `recoveryLeaseDeadlineAt`.
4. **Absolute recovery window**: recovery cannot extend beyond
   `recoveryDeadlineAt`, even if the lease keeps being renewed.

Defaults:

- client wait: 10 minutes;
- task timeout: 30 minutes;
- maximum task timeout: 60 minutes;
- active task grace: 60 seconds;
- recovery lease: 3 minutes;
- absolute recovery and late-reply grace: 30 minutes after the soft deadline.

After a page-submitted task crosses its soft deadline, it becomes `recovering`
instead of `failed`. Active generation or the exact submitted user message with
no assistant reply is strong evidence; the extension reports
`recovery_observed` while that evidence remains visible. Generic heartbeat,
history hydration, or an empty DOM does not renew the lease.

The task becomes terminal when the user or agent cancels it, the session
heartbeat disappears, the recovery lease expires, or the absolute recovery
deadline arrives. A visible submitted message or active generation is never
preempted merely because newer work is queued. If delivery is still genuinely
uncertain and the fully hydrated page is stably idle, the existing queue-aware
release path may fail it as `submission_outcome_unknown`; it is never requeued
or resent automatically.

If an eligible task fails before the absolute recovery deadline and its
observer later finds a reply, the reply is stored in `lateReply`. This is a
compatibility path for true terminal failures; ordinary long-running output
finishes from `recovering` into `done`.

If one `GET /v1/tasks/:id?wait=60000` call returns a non-terminal state, continue
polling. An HTTP long-poll timeout is not a task timeout.

## Idempotency

`clientRequestId` is unique within one session:

```text
(session, clientRequestId)
```

Network retries, agent restarts, and calls that may run more than once should
reuse a stable key. The same key in a different session creates a different
task.

## Pending recovery

`client/agent-client.ts` and the root CLI write pending task records to
`GPT_RELAY_PENDING_DIR`.

After a CLI interruption:

```bash
gpt-relay resume
gpt-relay show <task-id>
```

`recovering` tasks stay pending and `resume` reports that the original request
may still complete. Agents must inspect the existing task and must not submit a
duplicate prompt. Eligible terminal failures can remain pending inside the
late-reply window so that later output can be recovered.

## HTTP examples

### Submit

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/tasks \
  -H "Content-Type: application/json" \
  --data-binary @request.json
```

`request.json`:

```json
{
  "session": "<session-id>",
  "text": "<prompt>",
  "clientRequestId": "<stable-key>"
}
```

### Long poll

```bash
curl -sS "http://127.0.0.1:8765/v1/tasks/<task-id>?wait=60000"
```

To wait for either a terminal transition or progress newer than a known
revision:

```bash
curl -sS "http://127.0.0.1:8765/v1/tasks/<task-id>?wait=60000&progress_after=<revision>"
```

### List

```bash
curl -sS "http://127.0.0.1:8765/v1/tasks?session=<session-id>&status=queued,in_progress,recovering&limit=20"
```

For large or non-ASCII input, prefer files, stdin, or
`--data-binary @file` over dense shell quoting.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GPT_RELAY_URL` | `http://127.0.0.1:8765` | Client and CLI base URL |
| `GPT_RELAY_PORT` | `8765` | Server port and CLI URL fallback |
| `GPT_RELAY_HOST` | `127.0.0.1` | Server bind host |
| `GPT_RELAY_DATA_DIR` | `~/.gpt-relay` | Data directory |
| `GPT_RELAY_DB_FILE` | `<data-dir>/gpt-relay.db` | SQLite database |
| `GPT_RELAY_LOG_DIR` | `<data-dir>/logs` | Server log directory |
| `GPT_RELAY_PENDING_DIR` | `~/.gpt-relay/pending` | Client pending records; currently independent from `GPT_RELAY_DATA_DIR` |
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | Default task lifetime before active-task grace |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | Maximum task timeout |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | Grace before an active task enters recovery |
| `GPT_RELAY_RECOVERY_LEASE_MS` | `180000` | Lease renewed by strong recovery evidence |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | Absolute recovery and late-reply grace |
| `GPT_RELAY_HEARTBEAT_STALE_MS` | `60000` | Stale session heartbeat threshold |
| `GPT_RELAY_SESSION_ACTIVE_MS` | `30000` | Window in which a session is active |
| `GPT_RELAY_MAINTENANCE_INTERVAL_MS` | `5000` | Expiry and heartbeat maintenance interval |
| `GPT_RELAY_MAX_TASK_BYTES` | `524288` | Maximum prompt size |
| `GPT_RELAY_MAX_QUEUED_PER_SESSION` | `50` | Per-session queue limit |

## Sources of truth

- Public routes:
  [`server/routes/v1-tasks.ts`](./server/routes/v1-tasks.ts) and
  [`server/routes/v1-sessions.ts`](./server/routes/v1-sessions.ts)
- Internal routes:
  [`server/routes/internal.ts`](./server/routes/internal.ts)
- Task semantics:
  [`server/task-store.ts`](./server/task-store.ts)
- Agent client:
  [`client/agent-client.ts`](./client/agent-client.ts)
- CLI:
  [`bin/gpt-relay.ts`](./bin/gpt-relay.ts)
