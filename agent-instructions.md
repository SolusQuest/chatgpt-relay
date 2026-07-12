# gpt-relay — Agent 使用指南

面向 AI coding agent（Codex / Claude Code / 其他）的 API 说明。目标：一次读完就
能正确用 gpt-relay 让 ChatGPT web 参与 review / 交叉验证 / 长文本审阅。

## 一句话

gpt-relay 是本地 SQLite 队列服务，agent 提交 task → 浏览器扩展在 ChatGPT 页面执行
→ 回复回写到 SQLite → agent 拉回。默认地址 `http://127.0.0.1:8765`，数据落在
`~/.gpt-relay/gpt-relay.db`。所有 task 落盘、可续、可回查。

# 使用模式

用户可能通过 skill、slash command 或自然语言让你调用 relay。**具体触发时机由用户
或 skill 决定，不由本文档规定**；本节只给"当决定要用时该怎么组织内容"的实践。

## Session 假设（默认成立，除非证据表明相反）

Relay 背后是**用户本人的 ChatGPT 会话**，且用户已经在这些会话里预先构建了必要
的项目上下文。所以在你给 relay 发内容前，可以**默认假设**：

- **该 session 能访问 GitHub PR / Issue 链接**（包括用户自己 private repo 的），
  因为 ChatGPT connectors 已授权。**不需要**你把 PR diff / issue body 内联进 prompt
  —— 直接发 URL 即可。
- **该 session 有必要的项目 / repo / conversation 上下文**（架构约定、术语、
  正在处理的功能）。**不需要**在每次 prompt 里重复项目背景，也不需要解释你是谁。
- **该 session 是 authenticated user 的**：可以带一句话背景（例如"这是我在做 X
  feature 的一部分"），不用当陌生人问答对待。

**只在证据表明相反时**才降级到"补上下文"或"改问用户"：
- Relay 回复里明确说"我看不到这个链接" / "no access" / "please paste the content"
- 回复里出现明显跟 repo 无关的解读（例如把 auth 项目理解成金融 audit）
- 回复要求你解释某个用户/skill 明确定义过的术语

看到降级信号时的两条路径：
1. **补部分上下文**：你手边有的（PR body、关键文件内容、约定文档）直接贴进
   下一条 prompt，明确标注"补充上下文，因为 relay session 看不到 <X>"
2. **让用户决定**：如果需要的是用户端才能确定的东西（该给哪个 session 增加什么
   授权、要不要暴露 private repo），停下来问用户，不要自己猜

## PR review

**标准流程**：让 relay session 看**远端 PR 链接**，不要贴本地 diff。

1. 确认本地改动范围
2. commit + push 到远端分支
3. 用 `gh pr create` 或 web UI 创建/更新 PR（可以是 draft）
4. 把 PR URL 发给 relay

Prompt 骨架：
```text
请作为严格的代码 reviewer，review 下面这个 GitHub PR。

请优先列出需要修改的问题；如果没有阻塞问题，请明确说明可以合并，并列出
剩余风险。

PR: https://github.com/<user>/<repo>/pull/<n>
```

拿到反馈后 agent 自己判断是否修改，改完 → commit / push 到同一分支 →
用同一 URL 再发一次复审。**不要用关键词匹配判断是否通过**，读原文语义。

## Issue / draft / 短文本 review

无远端 URL 的内容（issue body draft、design note、prompt draft、commit message
草稿），直接把**完整文本**贴进 prompt。不要只贴摘要或"关键部分"。

多个 draft 一次性提交时按顺序编号：

```text
请作为严格的 PM/工程 reviewer，review 下面的 GitHub issue body draft。

重点：scope、验收标准、依赖 / 风险、可执行性、含糊措辞。
按严重程度列问题；没有阻塞问题就明确说可以推进。

## Issue Draft 1
<全文>

## Issue Draft 2
<全文>
```

## 长文档 / 大段代码

- 单个 prompt 上限 512 KB（body）。超过就分批：先发第一段，回复里包含"收到，
  等下一段"之类确认，再发下一段
- prompt 建议给 ≥10 min timeout（默认 10 min 就够）；PR 特别大可以传
  `"timeout": 1800000`（30 min）
- 长 prompt 建议开启幂等：给 `clientRequestId`（例如 `pr-1234-round-1`），
  agent 崩溃重启同一 CRI 不会重复提交

## 多 session 并发

一个 session 同时只处理一个 in-flight task。并发多 review 时：

1. `GET /v1/sessions` 取所有 `paused=false && pendingTasks==0` 的 session
2. 对每个 session **非阻塞** `POST /v1/tasks`（不循环等，立刻拿 taskId）
3. 所有提交完成后**再循环 GET** 拿结果

**不要**给同一 session 并发提交，会排队但看起来慢。

## 反模式（不要做）

- ❌ 把本地未 push 的 diff 内联到 prompt 请求 review —— 应该先 push，让 relay
  拉远端；这样 review 结论指向的行号跟你和用户看到的一致
- ❌ 因为怕 session 没上下文，把整个 repo README + AGENTS.md + 目标描述都
  塞进每次 prompt —— session 已经有上下文，多余
- ❌ 因为 ChatGPT 回复短，就补 prompt 再发 —— 先分析原回复够不够，够就用
- ❌ 用关键词匹配 relay 回复判断 "通过 / 不通过" —— 读语义
- ❌ 出现 pause / 验证码时自动重试 —— 停下告诉用户
- ❌ CJK 内容通过 `node -e "…"` 或 `curl -d "…"` 传大段中文 —— 用 stdin /
  `-d @file.json` / `agent-client.review()`

---

# API 参考

所有响应都是 `application/json`。URL 前缀 `http://127.0.0.1:8765`（可用 `GPT_RELAY_URL`
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
  "timeoutMs": 600000,                     // 从 submittedAt 起算的软超时
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
  "timeout": 600000,              // 可选。默认 GPT_RELAY_DEFAULT_TIMEOUT_MS (10 min)
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
| 413 | `task_too_large` | text 超过 `GPT_RELAY_MAX_TASK_BYTES`（512 KB） |
| 429 | `queue_full` | 单 session queued 已达 `GPT_RELAY_MAX_QUEUED_PER_SESSION`（50） |

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
expired，扩展也不会再处理它。所以 `timeoutMs` 要给足；默认 10 分钟对绝大多数 review 都够用；长 PR / 大文档可以显式传更大的
`timeout`（例如 20-30 分钟）。

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
      -d "{\"session\":\"$SID\",\"text\":\"…prompt…\",\"timeout\":600000,\"clientRequestId\":\"$(uuidgen)\"}" \
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

**Task 一旦提交就永远能找回**（除非用户 `rm ~/.gpt-relay/gpt-relay.db`）。Agent 崩溃/
被 Ctrl-C，只要记下 taskId 即可：

```bash
curl -s "http://127.0.0.1:8765/v1/tasks/$T?wait=60000"
```

Node 里若用了 `client/agent-client.ts`，`review()` 提交时会写
`~/.gpt-relay/pending/<taskId>.json`。之后用 `resumePending()` 一次性扫回所有未
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
curl -sf http://127.0.0.1:8765/health >/dev/null && echo ok || echo "relay down; run: gpt-relay start"

# 2. 是否有活跃 ChatGPT tab
n=$(curl -sf http://127.0.0.1:8765/v1/sessions | jq -r '.sessions | length')
[ "$n" -gt 0 ] && echo "sessions=$n" || echo "no chatgpt tab; open chatgpt.com"

# 3. 是否有非 paused session
curl -sf http://127.0.0.1:8765/v1/sessions | jq '.sessions[] | select(.paused==false) | .session' | head -1
```

如无 relay：让用户运行 `gpt-relay start` 或 `npm start`。
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
| `GPT_RELAY_URL` | `http://127.0.0.1:8765` | agent 端 relay URL |
| `GPT_RELAY_PORT` | `8765` | server 端口 |
| `GPT_RELAY_HOST` | `127.0.0.1` | server 监听地址 |
| `GPT_RELAY_DATA_DIR` | `~/.gpt-relay` | 数据目录 |
| `GPT_RELAY_DB_FILE` | `$DATA_DIR/gpt-relay.db` | SQLite 文件 |
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `600000` | 单 task 默认超时（**仅当 POST 未传 `timeout` 字段时生效**） |
| `GPT_RELAY_MAX_TASK_BYTES` | `524288` | prompt 上限 |
| `GPT_RELAY_MAX_QUEUED_PER_SESSION` | `50` | 单 session 队列上限 |
| `GPT_RELAY_PENDING_DIR` | `$DATA_DIR/pending` | client-side pending files 目录 |

---

# 相关文档

- `README.md` — 项目总览、CLI 用法
- `skills/gpt-relay-review/SKILL.md` — Codex/Claude skill 定义（推荐给 skill runner 直接引用）
- `extension/README.md` — 扩展加载、恢复行为
