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

有远端 URL（如 issue/PR placeholder、草稿链接）的内容，优先只发 URL；没有
可访问链接时才贴**完整文本**。不要只贴摘要或"关键部分"。

如果 relay 反馈“看不到链接/缺上下文”，再按降级路径补齐对应文本。

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

## 讨论 / 独立思考 + 综合（advanced，仅在用户允许时用）

Relay 不止是 one-shot review 的执行器。**当用户明确允许**、且决策足够重要
（issue scope、test 覆盖策略、架构选型、命名规范等），可以进入"讨论模式"：
让 agent 和 relay session 各自**独立**思考后再综合，最后（必要时）多轮讨论
到收敛。

**为什么**：LLM 有 sycophancy 倾向——先看到对方的答案就容易顺着走。强制
"双方 blind output 后再合流"能拿到真的第二意见，而不是回声。

### 核心原则：并行独立 + barrier

**谁看谁的 prompt 决定了谁受谁影响。** 讨论模式的独立性靠**两条硬 barrier**
保证，两条都满足时 agent 与 relay 的独立思考**可以（且推荐）并行**：

1. **Submit relay 之前，agent 不写任何观点**——先构造好只含任务描述与必要
   客观事实（issue placeholder、待测代码、约束条件）的 prompt，**submit
   之后**才允许开始本地推理；
2. **拿到 relay 结果之前，agent 必须把自己的独立结论落到可见文本**
   （scratchpad / 草稿文件 / 消息 draft），不能只放在"心里"。这样综合阶段
   有两份可对照的独立文本，避免事后"我本来也是这么想的"式合流；
3. Relay 的第一条 prompt **不含 agent 的观点**；agent 拿到 relay 独立观点
   后才进入"综合 / 讨论"阶段。

违反任意一条就退化成 review 模式，讨论价值消失。

**为什么要并行**：agent 本地推理通常 5–30s，relay 一次往返 20–90s，串行
= 两者相加，并行 = max(两者)。用非阻塞提交把两段时间叠起来是"免费"收益，
且更贴合讨论的语义（同行同时下笔，再交换）。

**并行姿势**（伪代码）：

```ts
// T0: 先 submit relay 拿 taskId（非阻塞）
const { taskId } = await submitTask({ session, text: contextOnly, timeout: 600_000 });
// T0+ε: 立刻开始本地独立思考，并在 relay 回来之前写到 scratchpad
const agentThoughts = await thinkIndependentlyAndPersist(context);
// T1: 再阻塞等 relay（通常此时已经或即将返回）
const relayThoughts = await waitForTask(taskId, { timeoutMs: 600_000 });
// T2: 综合
const merged = synthesize(agentThoughts, relayThoughts);
```

**不适合并行的场景**（保持串行）：
- **Context 尚未定型**：雏形阶段两方对问题的理解就不同，先串行对齐 context
  再并行发散；
- **设计上就是串行**（agent 先决定范围 → relay 基于范围 review）：这不属于
  讨论模式，别硬套。

### 流程模板

```
Round 0 & 1 (并行):
        - 先向 relay submit 只含任务与客观事实的 prompt（拿 taskId）
        - 同时 agent 在 scratchpad 独立思考 → 落到文本 agent-output-A
        - 等 relay 返回 → relay-output-B
        （barrier：submit 前 agent 不写观点；拿到 B 前 A 必须已落文本）
Round 2: agent 比对 A 和 B，识别：
        - 交集（双方都覆盖的点）
        - 差集 A\B（agent 独有）
        - 差集 B\A（relay 独有）
        - 冲突（同一决策点意见相反）
Round 3+ (可选): 若差集或冲突显著，agent 发讨论 prompt：
        "我的观点是 <A>，你的观点是 <B>。请指出：
         (a) 我遗漏的关键点是什么？
         (b) 你没考虑到的约束是什么？
         (c) 冲突点 <X> 的 rationale trade-off。"
        → relay-output-C，再综合，循环。
终止：见"中止条件"。
```

### 具体应用：refine issue body

想让 issue body 从粗糙 draft 到打磨到位时，讨论优于单次 review：

```
Round 0 & 1 (并行):
         - submit relay：只把 placeholder / 概要发过去，问"列出你觉得需要
           明确的决策点"
         - 同时 agent 从 placeholder / requirements 独立列决策点，写入
           scratchpad（例如 ["scope 是否包含 X？", "AC 是否要包含性能指标？", ...]）
         - 等 relay 返回其独立决策点清单
Round 2: agent 综合两份清单 → 一份决策点 union；
         对分歧项（一方有一方无 / 双方相反）标注
Round 3+ (若需要): 就分歧项让 relay 进一步讨论
Round N: 收敛后，agent 用综合决策点重新起草 issue body（此时可以走
         "Issue draft review"模式让 relay 复审最终稿）
```

### 具体应用：设计 test coverage

写 test 前决定覆盖哪些路径 / 边界：

```
Round 0 & 1 (并行):
         - submit relay：给待测代码 + 需求描述，问"你会覆盖哪些场景？
           列 cases 和理由"
         - 同时 agent 独立列 test cases（基于自己读代码的理解），写入
           scratchpad
         - 等 relay 返回其独立 case 清单
Round 2: agent 对比两份 case 清单：
         - 双方都列的 → 高置信度必写
         - 单方独有 → 判断是遗漏、是过度覆盖、还是各有侧重
         - 相反 (agent 说要测 X, relay 说不必测 X) → 讨论
Round N: 收敛后写 tests
```

### 中止条件

**收敛**（继续讨论会 overfit，停）：
- 双方指出的关键点集合基本相同（比方说 ≥80% 重合，剩下的只是描述方式）
- 分歧只剩风格 / 措辞，不是实质
- 连续两轮再无新论点出现

**分歧充分**（值得停下来问用户）：
- 双方对同一决策点各自展开了完整 rationale，仍然对立
- 这时不要再让讨论"卷"下去；把两份 rationale 摆给用户，让用户 tiebreak

**轮数上限**（防止无限循环）：
- 默认硬上限 **3 轮讨论**（不含 Round 0 / Round 1 的独立输出）
- 超过就停下来汇报当前状态，让用户决定

**外部信号**（无条件停）：
- session paused / 出验证码
- relay 出现降级信号（"我看不到" / 明显偏题）
- 用户中断

### 反模式（讨论专用）

- ❌ 把 agent 的独立观点直接放进 Round 1 prompt —— 就变回 review 模式
- ❌ 每轮都让 relay 评价 agent 的答案而不是拿独立观点 —— 同上
- ❌ 一直讨论到"看起来完美" —— overfit；讨论目的是找 blind spot，不是打磨
- ❌ 用讨论替代用户决策 —— 涉及项目方向 / 权衡的最终选择要问用户，不要
  agent 和 relay 自己收敛完就直接执行
- ❌ 每轮都新起 conversation —— 讨论模式**要利用 relay session 的连续
  上下文**，用**同一 session**多次 POST（相当于 ChatGPT 侧多轮对话）；
  这也是 relay 相对 API 的一大优势
- ❌ 串行等 relay 再开始本地思考 —— 白白浪费 20–90s；应在 submit 后立刻
  并行推理（前提是不违反两条 barrier）
- ❌ agent 独立结论只放"心里"，等 relay 回来后再"回忆" —— 无法验证独立性，
  容易 post-hoc 合流；必须先落到可见文本

---

## 长文档 / 大段代码

- 单个 prompt 上限 512 KB（body）。超过就分批：先发第一段，回复里包含"收到，
  等下一段"之类确认，再发下一段
- prompt 建议给 ≥10 min timeout（客户端轮询/等待默认 10 min；task 默认 30 min）；PR 特别大可以传
  `"timeout": 3600000`（60 min，上限）
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

`done | failed | cancelled | expired` 称为 **terminal**，之后不再变化。若 ChatGPT
在 timeout failure 后才完成，内容单独写入 `lateReply`，不会把 `failed` 改回
`done`。

## Task 对象

```jsonc
{
  "taskId": "8f31ac86-d619-45ec-8217-cd2a6ebed42e",
  "session": "6a534559-8910-83ee-be15-51f33b4a3601",
  "clientRequestId": null,                 // POST 时传入的 CRI（可为 null）
  "status": "done",
  "text": "…原始 prompt（仅 GET /v1/tasks/:id 返回）…",
  "reply": "…ChatGPT 回复（仅 done 时非 null）…",
  "lateReply": null,                       // timeout 后回收的晚到回复；不改写 status
  "error": null,                           // failed/cancelled/expired 时的原因
  "timeoutMs": 1800000,                    // 从 submittedAt 起算的 task 超时（默认 30 min）
  "submittedAt": 1783846951352,
  "dispatchedAt": 1783846986252,           // 扩展 claim 的时间；null 表示还未 claim
  "completedAt": 1783847074944,            // terminal 时间
  "lateCompletedAt": null,                 // lateReply 捕获时间
  "submitStartedAt": 1783846986255,        // 扩展开始页面提交
  "submitAcknowledgedAt": 1783846987312,   // content script 确认已点击 Send
  "generatingSeenAt": 1783846989344,       // 首次观察到页面生成中
  "replyDetectedAt": 1783847074200,        // 首次观察到稳定回复
  "expiresAt": 1783847251352,              // submittedAt + timeoutMs
  "completionDeadlineAt": 1783847311352,   // expiresAt + active task grace
  "lateReplyDeadlineAt": 1783849111352,    // hard deadline + bounded late window
  "requeueCount": 0                        // 被打回队列重试的次数
}
```

## 端点：`POST /v1/tasks` — 提交任务

**请求**：
```jsonc
{
  "session": "<sessionId>",       // 必填。UUID 或 ChatGPT conversation id
  "text": "<prompt>",             // 必填。≤ 512 KB
  "timeout": 1800000,             // 可选。默认 GPT_RELAY_DEFAULT_TIMEOUT_MS (30 min)，最大 3600000 (60 min)
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
- 拿到 `failed | cancelled | expired` → `error` 是原因，`reply` 为 null；timeout
  failure 仍可能在有界窗口内随后出现 `lateReply`
- 拿到 `queued | in_progress` → 任务仍在推进，隔一会儿再拉

queued task 越过 `expiresAt` 会变成不可挽回的 `expired`。已经发到页面的
in-progress task 越过 hard deadline 后会保持 `failed`，但扩展继续占用该 session
并在 `lateReplyDeadlineAt` 前回收网页最终回复到 `lateReply`。客户端等待默认
10 分钟，task 默认 30 分钟；CLI 用 `--wait-timeout`（兼容别名 `--timeout`）
和 `--task-timeout` 分别配置，后者最多 60 分钟。

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
4. **task timeout 是从 submittedAt 起算的墙钟**：即使 queued 期间也在消耗。
   任务超时默认 30 min，最大 60 min。客户端等待默认 10 min；CLI
   `--wait-timeout`/`--timeout` 不再缩短 task 生命周期，只有
   `--task-timeout` 会设置 POST 的 task timeout。
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
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | 单 task 默认超时（30 min，**仅当 POST 未传 `timeout` 字段时生效**） |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | 单 task 最大超时（60 min，超出时 capped） |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | hard deadline 后进行中 task 的 grace（60 sec） |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | hard deadline 后继续回收晚到回复的窗口（30 min） |
| `GPT_RELAY_MAX_TASK_BYTES` | `524288` | prompt 上限 |
| `GPT_RELAY_MAX_QUEUED_PER_SESSION` | `50` | 单 session 队列上限 |
| `GPT_RELAY_PENDING_DIR` | `$DATA_DIR/pending` | client-side pending files 目录 |

---

# 相关文档

- `README.md` — 项目总览、CLI 用法
- `skills/gpt-relay-review/SKILL.md` — Codex/Claude skill 定义（推荐给 skill runner 直接引用）
- `workflows/` — 多步 orchestration 模板；本文件里的模式在那里被组合成端到端流程
- `extension/README.md` — 扩展加载、恢复行为

