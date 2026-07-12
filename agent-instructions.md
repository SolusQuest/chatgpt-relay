# cgcon — Agent 使用指南

面向 AI coding agent（Codex / Claude Code / 其他）的 API 说明。目标：一次读完就
能正确用 cgcon 让 ChatGPT web 参与 review / 交叉验证 / 长文本审阅。

## 一句话

cgcon 是本地 SQLite 队列服务，agent 提交 task → 浏览器扩展在 ChatGPT 页面执行
→ 回复回写到 SQLite → agent 拉回。默认地址 `http://127.0.0.1:8765`，数据落在
`~/.cgcon/cgcon.db`。所有 task 落盘、可续、可回查。

## 何时用

**用**：
- 长文档、复杂设计、非 trivial refactor 需要"另一个模型"的意见
- 用户明确要求让 ChatGPT 看某段内容
- 高风险决策想交叉验证

**不用**：
- 简单的 self-review、格式化建议
- 处理敏感信息且用户未授权分享给 ChatGPT
- 用户明确指定了具体 API 模型

---

# API 参考

所有响应都是 `application/json`。URL 前缀 `http://127.0.0.1:8765`（可用 `CGCON_URL`
覆盖）。字段名统一 camelCase。所有时间戳都是**毫秒 Unix epoch**（`Date.now()`）。

## Status 枚举

| status | 含义 |
|---|---|
| `queued` | 已入队等待扩展认领 |
| `in_progress` | 扩展已认领并在与 ChatGPT 交互 |
| `done` | 成功，`reply` 有内容 |
| `failed` | 失败，`error` 有原因（含 session pause 时 in-flight 级联失败） |
| `cancelled` | agent 主动 DELETE |
| `expired` | 超过 `timeoutMs` 未完成 |

`done | failed | cancelled | expired` 称为 **terminal**，之后不再变化。

## Task 对象

```jsonc
{
  "taskId": "8f31ac86-d619-45ec-8217-cd2a6ebed42e",
  "session": "6a534559-8910-83ee-be15-51f33b4a3601",
  "clientRequestId": null,                 // POST 时传入的 CRI（可为 null）
  "status": "done",
  "text": "…原始 prompt（仅 GET /v1/tasks/:id 返回）…",
  "reply": "…ChatGPT 回复（仅 done 时非 null）…",
  "error": null,                           // failed/cancelled/expired 时的原因
  "timeoutMs": 300000,                     // 从 submittedAt 起算的软超时
  "submittedAt": 1783846951352,
  "dispatchedAt": 1783846986252,           // 扩展 claim 的时间；null 表示还未 claim
  "completedAt": 1783847074944,            // terminal 时间
  "expiresAt": 1783847251352,              // submittedAt + timeoutMs
  "requeueCount": 0                        // 被打回队列重试的次数
}
```

## 端点：`POST /v1/tasks` — 提交任务

**请求**：
```jsonc
{
  "session": "<sessionId>",       // 必填。UUID 或 ChatGPT conversation id
  "text": "<prompt>",             // 必填。≤ 512 KB
  "timeout": 300000,              // 可选。默认 CGCON_DEFAULT_TIMEOUT_MS (5min)
  "clientRequestId": "cli-abc"    // 可选。幂等 key，同 session 重复 POST 返回同一 taskId
}
```

**成功响应 `201`**：
```jsonc
{
  "taskId": "…",
  "status": "queued",
  "encodingWarning": "…",         // 可选：ASCII-lossy 输入告警
  "encodingFixed": "latin1-remap: …" // 可选：服务端自动修复 latin-1 mojibake
}
```

**错误**：
| HTTP | error code | 场景 |
|---|---|---|
| 400 | `invalid session` | session 缺失或格式非法 |
| 400 | `missing text` | text 为空 |
| 409 | `session_paused` | session 处于 paused 状态 |
| 409 | `duplicate_request` | 同 CRI 已有另一活跃 task（罕见） |
| 413 | `task_too_large` | text 超过 `CGCON_MAX_TASK_BYTES`（512 KB） |
| 429 | `queue_full` | 单 session queued 已达 `CGCON_MAX_QUEUED_PER_SESSION`（50） |

## 端点：`GET /v1/tasks/:id` — 查询 / 长轮询

**查询参数**：
- `wait=<ms>`：server 侧长轮询上限，最多挂起 `min(wait, 60000)` ms。单次
  HTTP 上限 **60 秒**（服务端 hard cap）。省略或 0 = 立即返回。

**响应**：完整 Task 对象（含 `text`）。**长轮询超时返回当前非-terminal 状态**
（不是错误、不是超时错误）。`404` 表示 taskId 不存在或已被清理。

### 关键语义：长轮询超时 ≠ 任务超时

`?wait=<ms>` 只是**这一次 HTTP 请求**的挂起上限，跟 task 本身的生命周期完全
独立。超时返回后**再次拉**（甚至下次进程启动后）仍能拿到最新状态，直到 task
进入 terminal 或 task 被从数据库删除。

具体：
- 拿到 `done` → `reply` 是最终答复
- 拿到 `failed | cancelled | expired` → `error` 是原因，reply 永远为 null
- 拿到 `queued | in_progress` → 任务仍在推进，隔一会儿再拉

`expired` 是唯一**不可挽回**的失败：一旦 `Date.now() > expiresAt`
（= `submittedAt + timeoutMs`）且仍未进入 terminal，服务端维护线程会把它标为
expired，扩展也不会再处理它。所以 `timeoutMs` 要给足；默认 5 分钟对 review
一般够用，长文档建议 10-15 分钟。

### 推荐拉取方式

**Agent 侧**：循环 `wait=60000`（最大化利用 hard cap，减少网络往返到"每分钟一次"）：

```bash
while :; do
  r=$(curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=60000")
  s=$(echo "$r" | jq -r .status)
  case "$s" in
    done)                      echo "$r" | jq -r .reply; break ;;
  # 其它 terminal
    failed|cancelled|expired)  echo "$r" | jq -r .error >&2; exit 2 ;;
  # queued / in_progress → 静默继续
  esac
done
```

**中断后恢复**：只要记下过 taskId，进程崩溃 / Ctrl-C / 重启后依旧能拉：

```bash
# 数小时后（只要没到 expiresAt）
curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=60000"
```

**避免的反模式**：
- ❌ 不带 `wait` 参数每秒轮询一次 → 浪费 CPU + 网络
- ❌ `wait > 60000` 期望挂更久 → 服务端会 cap 到 60s
- ❌ 单次 HTTP 超时就放弃 → 应该继续拉，任务往往仍在跑

## 端点：`DELETE /v1/tasks/:id` — 取消

- queued task → 立即变 `cancelled`
- in_progress task → server 端标记 cancelled；扩展当前提交会浪费但不会写回
- terminal task → `409 invalid_transition`

## 端点：`GET /v1/tasks` — 列表

**查询参数**：
- `session=<id>`
- `status=queued,done`（逗号分隔）
- `since=<ms>` — 只列 submittedAt ≥ since
- `limit=<n>`
- `include_text=1` — 返回原始 text（默认略去）

**响应**：`{"tasks": [Task, ...]}`。

## 端点：`GET /v1/sessions` — 列 session

```jsonc
{
  "sessions": [
    {
      "session": "6a534559-…",
      "lastSeen": 1783852452632,
      "lastStatusAt": 1783852452628,
      "paused": false,
      "pauseReason": null,
      "pausedAt": null,
      "pendingTasks": 0,         // queued 数量
      "inProgressTaskId": null   // 若有 in_progress，返回其 id
    }
  ]
}
```

无活跃 chatgpt tab 时返回空数组。

## 端点：`POST /v1/sessions/:id/pause` — 手动暂停

```jsonc
{ "reason": "manual pause" }  // 可选
```

Pause 后 `POST /v1/tasks` 会返回 409；已 in_progress 的会被 fail（`error` 含 pause 原因）。

## 端点：`POST /v1/sessions/:id/resume` — 恢复

无请求体。恢复后扩展下次 tick 自动恢复领任务。

## 端点：`GET /health` — 健康检查

```jsonc
{ "status": "ok", "sessions": 2 }   // sessions = 活跃 chatgpt tab 数
```

---

# 典型使用模式

## 提交并等待（阻塞）

```bash
SID=$(curl -s http://127.0.0.1:8765/v1/sessions | jq -r '.sessions[0].session')
T=$(curl -s -X POST http://127.0.0.1:8765/v1/tasks \
      -H "Content-Type: application/json" \
      -d "{\"session\":\"$SID\",\"text\":\"…prompt…\",\"timeout\":300000,\"clientRequestId\":\"$(uuidgen)\"}" \
      | jq -r .taskId)

# 循环 wait=30000 到 terminal
while :; do
  r=$(curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=30000")
  s=$(echo "$r" | jq -r .status)
  case "$s" in
    done)      echo "$r" | jq -r .reply; break ;;
    failed|cancelled|expired) echo "$r" | jq -r .error >&2; exit 2 ;;
  esac
done
```

## 提交并立即返回（非阻塞）

```bash
curl -s -X POST http://127.0.0.1:8765/v1/tasks \
     -H "Content-Type: application/json" \
     -d "{\"session\":\"$SID\",\"text\":\"$PROMPT\",\"clientRequestId\":\"$CRI\"}" \
     | jq -r .taskId
# ↑ 立即返回 taskId，后续用 GET /v1/tasks/:id 拉

# 数分钟后：
curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=60000"
```

## 并发多 session

多 session 并发上限：每 session 只处理一个 in-flight task，但 N 个 session 并发。
先 `GET /v1/sessions` 挑 `paused=false && pendingTasks==0` 的多个 session，
对每个 `POST /v1/tasks` 非阻塞提交，再统一收结果。

## 恢复中断的 task

**Task 一旦提交就永远能找回**（除非用户 `rm ~/.cgcon/cgcon.db`）。Agent 崩溃/
被 Ctrl-C，只要记下 taskId 即可：

```bash
curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=60000"
```

Node 里若用了 `client/agent-client.ts`，`review()` 提交时会写
`~/.cgcon/pending/<taskId>.json`。之后用 `resumePending()` 一次性扫回所有未
完结 task。

## 幂等

传 `clientRequestId`（推荐 UUID）。同 session 内重复 POST 相同 CRI **不产生
新 task**，直接返回已存在的 taskId + 当前 status。用于：
- 网络重试
- Agent 崩溃后重新执行同一 skill

**注意**：CRI 是 `(session, clientRequestId)` 联合唯一。跨 session 相同 CRI
会各自创建独立 task。

---

# 使用前 sanity check

```bash
# 1. relay 是否在跑
curl -sf http://127.0.0.1:8765/health >/dev/null && echo ok || echo "relay down; run: cgcon start"

# 2. 是否有活跃 ChatGPT tab
n=$(curl -sf http://127.0.0.1:8765/v1/sessions | jq -r '.sessions | length')
[ "$n" -gt 0 ] && echo "sessions=$n" || echo "no chatgpt tab; open chatgpt.com"

# 3. 是否有非 paused session
curl -sf http://127.0.0.1:8765/v1/sessions | jq '.sessions[] | select(.paused==false) | .session' | head -1
```

如无 relay：让用户运行 `cgcon start` 或 `npm start`。
如无 session：让用户打开 chatgpt.com 并确认页面顶部绿色 banner `Relay: xxxxxxxx…`。
如全 paused：把 pauseReason 转告用户（通常是验证码 / 限速）。

---

# 常见坑

1. **session 必传且必须有效**：非空 ≤128 字符。空字符串 / null → 400。
2. **不要短轮询**：用 `?wait=30000` 让服务器挂起。持续 `curl` 空转是错误做法。
3. **taskId 是 UUID**：不要构造或猜 taskId，永远从 POST 响应拿。
4. **timeout 是从 submittedAt 起算的墙钟**：即使 queued 期间也在消耗。默认 5 min。
5. **encodingWarning ≠ 错误**：如果响应带这个字段，说明 shell 编码可能有损；
   task 仍会执行，但 CJK 输入的 agent 环境建议改用 `--stdin` + UTF-8。
6. **一个 session 同一时刻只能一个 task 在跑**：想并发就多用几个 session。

---

# 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `CGCON_URL` | `http://127.0.0.1:8765` | agent 端 relay URL |
| `CGCON_PORT` | `8765` | server 端口 |
| `CGCON_HOST` | `127.0.0.1` | server 监听地址 |
| `CGCON_DATA_DIR` | `~/.cgcon` | 数据目录 |
| `CGCON_DB_FILE` | `$DATA_DIR/cgcon.db` | SQLite 文件 |
| `CGCON_DEFAULT_TIMEOUT_MS` | `300000` | 默认单 task 超时 |
| `CGCON_MAX_TASK_BYTES` | `524288` | prompt 上限 |
| `CGCON_MAX_QUEUED_PER_SESSION` | `50` | 单 session 队列上限 |
| `CGCON_PENDING_DIR` | `$DATA_DIR/pending` | client-side pending files 目录 |

---

# 相关文档

- `README.md` — 项目总览、CLI 用法
- `skills/cgcon-review/SKILL.md` — Codex/Claude skill 定义（推荐给 skill runner 直接引用）
- `extension/README.md` — 扩展加载、恢复行为
