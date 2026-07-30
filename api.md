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
| `done` | Completed successfully; `reply` contains the final output |
| `failed` | Failed; `error` contains the reason |
| `cancelled` | Cancelled by the agent or page user |
| `expired` | Passed its deadline before being claimed |

`done`, `failed`, `cancelled`, and `expired` are terminal. A result that arrives
after a timeout is stored in `lateReply`; it does not change the original
terminal status back to `done`.

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
  "expiresAt": 1783848751352,
  "completionDeadlineAt": 1783848811352,
  "lateReplyDeadlineAt": 1783850611352,
  "requeueCount": 0
}
```

`text` is returned only by a single-task query or when a list request includes
`include_text=1`.

### Server-generated task errors

The relay uses stable machine-readable codes for maintenance failures:

| Code | Meaning |
|---|---|
| `task_expired_before_dispatch` | A queued task crossed its deadline before the extension claimed it |
| `task_processing_timeout` | An in-progress task crossed its deadline and active-task grace period |
| `submission_outcome_unknown` | Send may have been attempted, but the extension could not confirm submission before the deadline or before safely advancing queued work |
| `session_heartbeat_lost` | The relay released an in-progress task after its browser session became stale |
| `aborted` | The extension task wait was aborted |

Extension-originated failures can include a descriptive `error` string. Clients
must use `status` to identify terminal tasks and should display unknown error
values rather than rejecting them.

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
- `timeout`: optional server-side task lifetime; 30 minutes by default and
  capped at 60 minutes.
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

When the task becomes terminal, the long poll returns immediately. If the poll
ends while the task is still running, it returns the current `queued` or
`in_progress` state; that response is not an error.

`404` means the task does not exist or has been cleaned up.

### `DELETE /v1/tasks/:id`

Cancel a task:

- `queued` becomes `cancelled` immediately.
- `in_progress` becomes `cancelled`; current page generation may still consume
  resources, but it is not stored as a normal reply.
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
      "inProgressTaskId": null
    }
  ]
}
```

An empty array means that no ChatGPT tabs are currently active.

### `POST /v1/sessions/:id/pause`

Pause a session manually:

```json
{
  "reason": "manual pause"
}
```

Pausing blocks new tasks and fails all queued and in-progress tasks in that
session.

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
- `reply_detected`

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
  |-- capture/complete success --------------------> done
  |-- complete error/maintenance timeout ----------> failed
  |-- cancel/user-stop ----------------------------> cancelled
  |-- defer/requeue before send_attempted ----------> queued
  `-- late DOM result after eligible failure ------> lateReply on terminal task
```

Each session can have at most one `in_progress` task. Queued tasks are claimed
in submission order.

`send_attempted` is a durable at-most-once fence. After that phase is recorded, `defer` and `requeue` return `400 unsafe_retry_after_send_attempt`; clients must create an explicit new task if a human chooses to retry.

## Timeouts and late replies

Keep three time dimensions separate:

1. **Client wait timeout**: how long the CLI or agent client waits in the
   current call. It does not alter task state.
2. **Task timeout**: the wall-clock deadline from `submittedAt`, represented by
   `expiresAt`.
3. **Late-reply window**: a bounded period during which the extension continues
   recovering page output after an in-progress task crosses its hard deadline.

Defaults:

- client wait: 10 minutes;
- task timeout: 30 minutes;
- maximum task timeout: 60 minutes;
- active task grace: 60 seconds;
- late-reply grace: 30 minutes.

After a page-submitted task crosses its hard deadline, it remains `failed`, but the extension can store final page output in `lateReply` before `lateReplyDeadlineAt`. A task with `sendAttemptedAt` but without later acknowledgement evidence fails as `submission_outcome_unknown` instead of being automatically replayed.

Late-reply observation normally keeps the session exclusive so a later reply cannot be attributed to newer work. New queued work may preempt that observation only after the page is fully hydrated and stably idle. In that case, the uncertain task remains terminal and is never replayed; the extension clears its browser-side observer before claiming the next task.

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

Terminal tasks remove their pending record. A timeout failure that remains
inside its late-reply window stays pending so that later output can be
recovered.

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

### List

```bash
curl -sS "http://127.0.0.1:8765/v1/tasks?session=<session-id>&status=queued,in_progress&limit=20"
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
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | Default task timeout |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | Maximum task timeout |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | Grace after the hard deadline |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | Late-reply recovery window |
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
