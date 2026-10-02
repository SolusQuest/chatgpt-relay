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

## Session maintenance and controls

`GET /v1/sessions/:id/inspect` accepts a conversation ID or session reference. It returns registry identity, server pause/suspension state, active task, queued count, and `pageStatus` (`observed`, `ambiguous`, `unknown`). `page` is null unless exactly one page was observed within 30 seconds; historical `pages` carry `observedAt` and `stale`. No composer text is reported.

`GET /v1/doctor?session=:id` returns server version/protocol and observed extension version, protocol compatibility and DOM capabilities. Omit `session` to inspect known active sessions. Missing messages in a virtualized or new conversation yield null capabilities, not failure.

`POST /v1/sessions/:id/suspend` and `/continue` set the durable `suspended` dispatch gate. They neither cancel active tasks nor discard queued work, and do not change safety pause state. Task deadlines still apply.

`GET /v1/tasks/:id/trace` returns `{taskId, completeHistory, events:[{seq, at, event, detail}]}`. Events include creation, status transitions, submission preparation, send fence, acknowledgement, generation, reply detection and recovery. Legacy tasks have incomplete history. Stop is represented by cancellation with its reason.

`POST /v1/session-controls` accepts `{operationId, kind, session?, taskId?}`. `operationId` is a caller-retained 8–100 character identifier (`A-Z`, `a-z`, digits, `_`, `-`). `kind` is `refresh`, `recover`, or `stop`. Refresh requires `session` (reference or conversation ID), and optionally `taskId` to preserve observation of that active task. Recover and Stop require `taskId`. Reusing the same operation ID and target returns the existing operation; conflicting payloads return 409. An active operation holds new task claims for its session.

The 202 response and `GET /v1/operations/:id` expose `operationId`, `session`, `taskId`, `kind`, `state`, `createdAt`, `expiresAt`, `error`, `errorInfo`, and `result`. States are `queued`, `claimed`, `executing`, `succeeded`, `blocked`, or `unknown`. Operations expire after 120 seconds. A durable execution fence prevents repeated refresh/Stop actions after worker restart; an uncertain fence or missing post-reload observation is not proof of success. Do not automatically repeat an `unknown` operation using a new ID.

Recover requires an active task with a Send fence and surviving original browser evidence. Its result is `observation_attached`; obtain completion through the original task endpoint. Refresh requires a uniquely mapped fresh page, no draft and either no active task or the explicitly specified sent task. Success (`page_refreshed`) requires a different document and page readiness or resumed generation. Stop results separately expose `stopRequested` (boolean or null), `pageGenerationState` (`stopped`, `generating`, `unknown`), and `relayTaskStatus`; transport success does not imply generation stopped.

HTTP failures, failed tasks and failed operations expose `errorInfo: {code, message, deliveryState, safeToResubmit, nextAction}` while retaining the existing `error` field. `safeToResubmit: null` means unknown, never permission to resend. Inspect the original task and operation before retrying.

Extension-only maintenance endpoints: `POST /internal/session-snapshots` reports whitelisted observations; `POST /internal/session-controls/claim` takes an extension `owner`; `POST /internal/session-controls/:id/fence` takes `{owner, token, documentId}` and grants `execute: true` once; `/finish` takes `{owner, token, state, error?, result?}`. Ownership and tab identity are fixed when the public operation is created. These endpoints are not agent APIs.

## Task lifecycle statuses

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
  "submissionState": "replied",
  "submissionVerificationDeadlineAt": null,
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

`submissionState` is the Agent-facing delivery verdict. It is one of
`not_attempted`, `verifying`, `acknowledged`, `replied`, `not_observed`, or
`unknown`. After the durable Send fence, an unacknowledged task remains
`verifying` for two minutes from `sendAttemptedAt`; during that state,
`submissionVerificationDeadlineAt` exposes the exact deadline. A visible
submitted message or generation changes the state to `acknowledged`. A normal
or late reply changes it to `replied`.

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
| `submission_not_observed` | The two-minute verification window ended on a fully observed idle page, while prompt or attachment residue had been observed in the composer |
| `submission_outcome_unknown` | The two-minute verification window ended without enough page evidence to prove either submission or non-submission |
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

### Stable references and creation

`sessionRef` is an agent-owned stable reference matching `sr_` followed by 1 to 120 ASCII letters, digits, underscores or hyphens. `conversationId` is ChatGPT's actual conversation ID and may initially be null. Existing `session` selectors retain support. For message submission, provide exactly one selector; for listings, `sessionRef` is also supported. Both selectors resolve to the same task queue, active slot and idempotency scope. Task and session views add `sessionRef` and `conversationId` without removing existing fields.

`POST /v1/sessions` requires `sessionRef`, nonempty `text` and an explicit `projectId` (a Project ID or null for an ordinary chat). It also accepts the existing `timeout` and optional `clientRequestId` options. Creation atomically stores the reference, browser command and first task.

```jsonc
{
  "sessionRef": "sr_<agent-generated-reference>",
  "projectId": null,
  "text": "First task with its necessary context"
}
```

The response contains `taskId`, task `status`, `sessionRef`, nullable `conversationId`, `projectId`, `creationStatus`, `initialTaskId`, `initialTaskStatus` and `creationError`. Repeating the same ref with the same effective Project, text and timeout returns the original first task, even after failure. Different parameters conflict with `409`. Recreating a definitively failed attempt requires a fresh ref.

`GET /v1/sessions/:ref` returns creation and binding metadata, including `initialTaskId` for recovery after a lost response. It remains available even when the browser heartbeat has expired. `GET /v1/sessions` continues listing active sessions and adds the reference metadata. Existing pause/resume routes resolve either identity.

Creation status is independent of first-task status:

| Status | Meaning |
|---|---|
| `pending` | Creation or binding is still underway |
| `created` | The owned page's conversation ID has been bound, even if the first task failed |
| `failed` | Creation terminated without an ID or uncertain browser open/Send evidence |
| `unknown` | The page may have opened or the message may have been submitted, but binding is unresolved |

An existing ID does not imply the page is ready, unpaused or finished generating. An unknown result must be observed rather than automatically recreated and replayed. Late binding can establish `created`; task failure and late replies remain independent. Messages into failed or unknown creations are rejected, while queued successors to a pending creation cannot execute before binding.

### Local Project catalog

`GET /v1/projects` returns `{ "projects": [...] }`, with `projectId`, `name`, nullable `description` and `updatedAt` on each entry. Project IDs use `g-p-` followed by 32 hexadecimal digits; an optional name slug is accepted and normalized away. Names are display metadata, not a creation selector.

`PUT /v1/projects/:projectId` upserts local metadata with a required nonempty `name` (at most 200 characters) and optional `description` (at most 4000 characters). Omitting description preserves its old value; null clears it. `DELETE /v1/projects/:projectId` removes the local entry. These operations do not mutate ChatGPT Projects. The catalog is not an allowlist: a syntactically valid directly supplied ID can be used without registration, with page identity checked before sending. There is no default Project or fallback to ordinary chat on a Project mismatch.

### Browser creation control

Creation commands are independent of any existing session. The extension polls `POST /internal/session-creations/claim` using its persisted owner identity. Commands include the ref, Project ID, attempt token and open state. It fences `opening` before opening a marked tab, then records `attach` and validates `bind`. The owned token and tab must match; an unrelated tab cannot bind the ref. An uncertain open is reported unknown instead of opening another page. After browser restoration changes tab IDs, reassociation requires the extension to verify the old tab no longer exists and present the prior ownership through `reattach`. The ownership token provides local execution correlation, not an authentication boundary.

The internal endpoints are implementation details, not agent integration APIs.

### Project discovery

`POST /v1/projects/discover` with `{ "save": false }` queues an extension-level DOM scan and returns `202` with `discoveryId`, `status` and `save`. `save` defaults to false. `GET /v1/projects/discover/:id` polls the durable result; jobs expire after two minutes. The CLI equivalent is `gpt-relay projects discover [--save] [--no-wait]`, with JSON output.

The extension scans visible Project entries in already-open ChatGPT tabs. It supports classic Project links and modern sidebar rows exposing `data-app-action-sidebar-project-id` and `data-app-action-sidebar-project-label`, with the latter label checked against displayed name text. It does not limit discovery to the current tab's Project, navigate, expand collapsed sections or fetch private webpage APIs. Results include `projects` (ID and name), `sources` (page URL, observed entry count and errors), `warnings`, `saved`, `scope: "open-chatgpt-tabs-visible-project-links"` and `complete: false`. Link evidence must point to an exact `/g/<project-id>/project` route on chatgpt.com; modern rows supply the canonical Project URL. Conversation, off-site and message-body entries are excluded. With save enabled, observed names update by ID while descriptions and unobserved catalog entries remain intact. Conflicting names for one ID are reported and skipped. Empty readable scans can complete successfully with zero projects; no readable tabs yields `failed` with `no_readable_chatgpt_tabs`.

The worker uses `/internal/project-discoveries/claim` and `/internal/project-discoveries/:id/complete` with a persisted owner and attempt token. Read-only scans can resume after worker restart; catalog merge and result completion commit atomically. Late completion of an expired job is rejected.

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

- `session`: legacy session selector, non-empty, at most 128 characters; provide either this or `sessionRef`.
- `sessionRef`: stable registered reference; mutually exclusive with `session`.
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
preempted merely because newer work is queued. If delivery is still
unacknowledged, the extension keeps a fixed two-minute verification window from
`sendAttemptedAt`; queued successors do not shorten that window. A fully
observed `not-started` page plus recorded composer payload ends as
`submission_not_observed`. Missing, loading, hydrating, or otherwise ambiguous
page evidence ends as `submission_outcome_unknown`. Neither outcome requeues or
resends the prompt automatically.

If an eligible task fails before the absolute recovery deadline and its
observer later finds a reply, the reply is stored in `lateReply`. This is a
compatibility path for true terminal failures; ordinary long-running output
finishes from `recovering` into `done`.

If one `GET /v1/tasks/:id?wait=60000` call returns a non-terminal state, continue
polling. An HTTP long-poll timeout is not a task timeout.

## Idempotency

`clientRequestId` is unique within one canonical execution session. A legacy ID and its ref share this scope:

```text
(session, clientRequestId)
```

Network retries, agent restarts, and calls that may run more than once should
reuse a stable key. The same key in a different session creates a different
task.

Reusing a key with different effective text or task timeout returns `409`. CLI/client message calls generate keys by default; REST callers may omit the field for compatibility. A new CLI invocation generates a new key, so recovery should use `resume` or explicitly reuse `--cri`.

## Pending recovery

`client/agent-client.ts` and the root CLI write pending task records to
`GPT_RELAY_PENDING_DIR`.

The client first persists a request identity before HTTP submission, then replaces it with the acknowledged task record. `resume` queries an unacknowledged message by its session selector and `clientRequestId`, including requests accepted before a lost response. Creation recovery instead queries the ref's original `initialTaskId`, since creation retries can carry a different message key. An unmatched record remains `UNCONFIRMED`; recovery does not resubmit it. Records with an explicit base URL are recovered only against that same relay.

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
