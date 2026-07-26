# gpt-relay API Reference

本文是 gpt-relay HTTP 协议的权威参考。Agent 的日常 review 操作见 [`agent-instructions.md`](./agent-instructions.md)；人类使用 CLI 和安装扩展见 [`README.md`](./README.md)。

## 基础约定

- 默认 base URL：`http://127.0.0.1:8765`
- 可通过 `GPT_RELAY_URL` 或 server 端 `GPT_RELAY_HOST` / `GPT_RELAY_PORT` 覆盖
- JSON endpoint 使用 `application/json`
- 所有时间戳都是毫秒 Unix epoch
- Public agent API 使用 `/v1/*`
- `/internal/*` 只供浏览器扩展使用，不是稳定的 agent integration surface

## Task status

| Status | 含义 |
|---|---|
| `queued` | 已入队，等待扩展认领 |
| `in_progress` | 扩展已认领并正在页面执行 |
| `done` | 成功，`reply` 有最终回复 |
| `failed` | 失败，`error` 有原因 |
| `cancelled` | Agent 或页面用户主动取消 |
| `expired` | Task 在被认领前越过 deadline |

`done | failed | cancelled | expired` 是 terminal status，之后不会改写。Timeout 后页面晚到的结果存入 `lateReply`，不会把原 terminal status 改回 `done`。

## Task object

```jsonc
{
  "taskId": "8f31ac86-d619-45ec-8217-cd2a6ebed42e",
  "session": "6a534559-8910-83ee-be15-51f33b4a3601",
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
  "submitAcknowledgedAt": 1783846987312,
  "generatingSeenAt": 1783846989344,
  "replyDetectedAt": 1783847074200,
  "expiresAt": 1783848751352,
  "completionDeadlineAt": 1783848811352,
  "lateReplyDeadlineAt": 1783850611352,
  "requeueCount": 0
}
```

`text` 只在单 task 查询或 list 请求带 `include_text=1` 时返回。

## Public API

### `POST /v1/tasks`

提交一个 task。

Request：

```jsonc
{
  "session": "<task-specific-session-id>",
  "text": "<full prompt>",
  "timeout": 1800000,
  "clientRequestId": "stable-idempotency-key"
}
```

字段：

- `session`：必填，非空且不超过 128 字符。
- `text`：必填，非空，默认最大 512 KiB。
- `timeout`：可选，服务端 task 生命周期；默认 30 分钟，最大 60 分钟。
- `clientRequestId`：可选；与 session 组成幂等 key。

成功响应 `201`：

```json
{
  "taskId": "...",
  "status": "queued"
}
```

输入编码可疑时可能附带：

- `encodingWarning`：疑似 ASCII-lossy 输入，task 仍会执行。
- `encodingFixed`：服务端已自动修复可识别的 mojibake。

常见错误：

| HTTP | `error` | 场景 |
|---|---|---|
| 400 | `invalid session` | session 缺失或非法 |
| 400 | `missing text` | text 为空 |
| 409 | `session_paused` | session 已暂停 |
| 413 | `task_too_large` | prompt 超过 task 限制 |
| 429 | `queue_full` | session queued task 达到上限 |

### `GET /v1/tasks/:id`

读取完整 task。

可选 query：

- `wait=<ms>`：server-side long poll，最多 60,000 ms。

Task 进入 terminal 后 long poll 会立即返回。Long poll 到时但 task 仍未完成时，返回当前 `queued` 或 `in_progress` 状态，不是错误。

`404` 表示 task 不存在或已被清理。

### `DELETE /v1/tasks/:id`

取消 task：

- `queued` → 立即 `cancelled`
- `in_progress` → 标记 `cancelled`；页面当前生成可能仍会消耗资源，但结果不写成正常 reply
- terminal task → `409 invalid_transition`

响应为不含 `text` 的 Task object。

### `GET /v1/tasks`

列出 tasks。

Query：

- `session=<id>`
- `status=queued,done`
- `since=<epoch-ms>`
- `limit=<positive-int>`
- `include_text=1`

Response：

```json
{
  "tasks": []
}
```

非法 status 会被忽略。默认 limit 是 50，最小 1，最大 500。

### `GET /v1/sessions`

列出当前活跃 session。

```jsonc
{
  "sessions": [
    {
      "session": "6a534559-...",
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

没有活跃 ChatGPT tab 时返回空数组。

### `POST /v1/sessions/:id/pause`

手动暂停 session。

```json
{
  "reason": "manual pause"
}
```

Pause 会阻止新 task，并使该 session 当前所有 queued 和 in-progress task 失败。

### `POST /v1/sessions/:id/resume`

恢复 session。无 request body。

### `GET /health`

```json
{
  "status": "ok",
  "sessions": 2
}
```

`sessions` 是当前活跃 session 数，不代表全部可用或未暂停。

## Extension-internal API

以下 endpoint 挂载在 `/internal`，只供 MV3 extension 使用。Agent 应使用 `/v1` API 或根级 CLI。

| Method | Path | 用途 |
|---|---|---|
| GET | `/internal/next_task?session=&wait=` | 心跳并长轮询、认领下一个 queued task；wait 最大 25 秒 |
| POST | `/internal/tasks/:id/capture` | 捕获 DOM 回复；必要时写入 late reply |
| POST | `/internal/tasks/:id/progress` | 记录页面 lifecycle phase |
| POST | `/internal/tasks/:id/complete` | 正常完成或失败 task |
| POST | `/internal/tasks/:id/user-stop` | 页面用户点击 Stop 后取消 task |
| POST | `/internal/tasks/:id/recover` | 页面刷新或扩展重启后回捞 DOM 回复 |
| POST | `/internal/tasks/:id/defer` | 页面仍忙时把刚认领 task 无损退回 queued |
| POST | `/internal/tasks/:id/requeue` | 回捞失败后重新排队并增加 requeue count |
| POST | `/internal/heartbeat` | 更新 session heartbeat |
| POST | `/internal/sessions/:id/status` | 上报 pause/resume 和 reason |

Progress phase：

- `submit_started`
- `submit_acknowledged`
- `generating_seen`
- `reply_detected`

Internal endpoint 的具体 request/response contract 以 [`server/routes/internal.ts`](./server/routes/internal.ts) 和 extension integration tests 为准。

## Task lifecycle

```text
queued
  ├─ claim → in_progress
  ├─ cancel → cancelled
  └─ deadline before claim → expired

in_progress
  ├─ capture/complete success → done
  ├─ complete error/maintenance timeout → failed
  ├─ cancel/user-stop → cancelled
  ├─ defer/requeue → queued
  └─ late DOM result after timeout → lateReply on existing terminal task
```

同一 session 最多一个 `in_progress` task。Queued tasks 按提交顺序认领。

## Timeout 与晚到回复

三个时间维度必须区分：

1. **Client wait timeout**：CLI 或 agent client 本次等待多久。到时不会改变 task 状态。
2. **Task timeout**：从 `submittedAt` 开始的墙钟 deadline，对应 `expiresAt`。
3. **Late reply window**：in-progress task 越过 hard deadline 后，扩展继续有界回收页面回复的窗口。

默认值：

- Client wait：10 分钟
- Task timeout：30 分钟
- Task timeout 上限：60 分钟
- Active task grace：60 秒
- Late reply grace：30 分钟

已经提交到页面的 task 越过 hard deadline 后会保持 `failed`，但扩展可以在 `lateReplyDeadlineAt` 前把最终页面输出写入 `lateReply`。

单次 `GET /v1/tasks/:id?wait=60000` 返回非 terminal 状态时，应继续查询；不要把 HTTP long-poll 返回等同于 task timeout。

## Idempotency

`clientRequestId` 在同一 session 内唯一：

```text
(session, clientRequestId)
```

网络重试、agent 重启或可能重复执行的调用应复用稳定 key。跨 session 使用相同 key 会创建不同 task。

## Pending recovery

`client/agent-client.ts` 和根级 CLI 会在 `GPT_RELAY_PENDING_DIR` 写入 task 记录。CLI 中断后：

```bash
gpt-relay resume
gpt-relay show <taskId>
```

Terminal task 会清理 pending record；仍处于 late-reply window 的 timeout failure 会继续保留，供之后回收。

## HTTP examples

### 提交

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/tasks \
  -H "Content-Type: application/json" \
  --data-binary @request.json
```

`request.json`：

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

### 列表

```bash
curl -sS "http://127.0.0.1:8765/v1/tasks?session=<session-id>&status=queued,in_progress&limit=20"
```

Windows/CJK 环境优先使用文件、stdin 或 `--data-binary @file`，避免密集 shell quoting。

## Environment variables

| 变量 | 默认 | 用途 |
|---|---|---|
| `GPT_RELAY_URL` | `http://127.0.0.1:8765` | Client/CLI base URL |
| `GPT_RELAY_PORT` | `8765` | Server port；CLI 未设置 URL 时也用于构造 base URL |
| `GPT_RELAY_HOST` | `127.0.0.1` | Server bind host |
| `GPT_RELAY_DATA_DIR` | `~/.gpt-relay` | 数据目录 |
| `GPT_RELAY_DB_FILE` | `<data-dir>/gpt-relay.db` | SQLite 文件 |
| `GPT_RELAY_LOG_DIR` | `<data-dir>/logs` | Server log 目录 |
| `GPT_RELAY_PENDING_DIR` | `~/.gpt-relay/pending` | Client-side pending record 目录；当前不随 `GPT_RELAY_DATA_DIR` 自动变化 |
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | POST 未指定 timeout 时的 task timeout |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | Task timeout 上限 |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | Hard deadline 后 active task grace |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | Late reply 回收窗口 |
| `GPT_RELAY_HEARTBEAT_STALE_MS` | `60000` | Session heartbeat stale threshold |
| `GPT_RELAY_SESSION_ACTIVE_MS` | `30000` | Session 被视为活跃的窗口 |
| `GPT_RELAY_MAINTENANCE_INTERVAL_MS` | `5000` | Expiry/heartbeat maintenance 间隔 |
| `GPT_RELAY_MAX_TASK_BYTES` | `524288` | 单 task prompt 上限 |
| `GPT_RELAY_MAX_QUEUED_PER_SESSION` | `50` | 单 session queued 上限 |

## Source of truth

- Public routes：[`server/routes/v1-tasks.ts`](./server/routes/v1-tasks.ts)、[`server/routes/v1-sessions.ts`](./server/routes/v1-sessions.ts)
- Internal routes：[`server/routes/internal.ts`](./server/routes/internal.ts)
- Task semantics：[`server/task-store.ts`](./server/task-store.ts)
- Agent client：[`client/agent-client.ts`](./client/agent-client.ts)
- CLI：[`bin/gpt-relay.ts`](./bin/gpt-relay.ts)
