# gpt-relay — Agent 使用指南

本文只描述 agent 应如何使用 gpt-relay 完成 review、第二意见和独立讨论。HTTP schema、task 生命周期、timeout 和 endpoint 细节见 [`api.md`](./api.md)；多阶段 issue-to-PR 编排见 [`workflows/`](./workflows/README.md)。

## 一句话

gpt-relay 是本地 SQLite 队列服务：agent 提交 task，浏览器扩展在用户自己的 ChatGPT 页面执行，回复写回本地数据库，agent 再通过 CLI 或 API 取回结果。

默认地址是 `http://127.0.0.1:8765`。优先使用根级 `gpt-relay` CLI；只有实现、调试或 CLI 无法覆盖时才直接调用 HTTP API。

## 不可变规则

- **必须使用用户为当前任务提供的 task-specific session。** 不得自行选择 idle、最近使用或旧任务 session。
- **同一 workflow 的所有 relay round 复用同一个 session。** 这样 issue、plan 和 PR review 才共享连续上下文。
- **Review 远端 artifact。** PR review 必须针对已经 commit、push 并创建或更新的远端 PR；不要用本地未 push diff 替代。
- **用户拥有产品决策和最终 merge 权限。** Agent 与 relay 可以发现问题、讨论取舍，但不能用双方共识替代用户决定。
- **Pause、captcha 或明确限速时停止。** 告诉用户原因，不自动重试。

## Session 假设

Relay 背后是用户本人已登录的 ChatGPT 会话。除非出现反证，可以默认：

- Session 能访问用户授权的 GitHub PR 和 issue URL，包括 private repository。
- Session 已有必要的项目术语、架构和当前任务上下文。
- 不需要在每一轮重复 README、仓库背景或完整 diff。

出现以下信号时才降级：

- Relay 明确说无法访问 URL 或要求粘贴内容。
- 回复明显把项目或术语理解错。
- Relay 缺少只有用户才能提供的授权或私有上下文。

降级时：

1. Agent 手头有必要上下文时，在下一轮补完整相关内容，并说明为什么补充。
2. 需要用户授权、session 选择或敏感信息时，停止并询问用户。

## 使用前检查

```bash
gpt-relay health
gpt-relay sessions
```

确认：

- Relay 可达。
- 用户提供的 session 出现在列表中。
- 该 session 没有 paused。
- 当前任务没有意外占用该 session 的 in-flight task。

如果用户尚未提供当前任务的 session ID，停止并请求提供。不要从列表中代选。

## 内容如何发送

### GitHub PR

先确认本地 scope，然后 commit、push 并创建或更新 draft PR。只有 workflow 或用户已授权这些写操作时才执行。

发送远端 PR URL，不要内联本地 diff：

```text
请作为严格的代码 reviewer review 下面这个 GitHub draft PR。

请优先列出必须修改的问题；如果没有阻塞问题，请明确说明 safe to request human
review，并列出剩余风险。

PR: https://github.com/<owner>/<repo>/pull/<n>
```

修复真实问题后，在同一分支 commit、push，并用相同 PR URL 和相同 session 复审。最终结论必须针对最新 pushed head。

### GitHub issue

有可访问的远端 issue 或 placeholder URL 时优先发送 URL。没有远端 artifact 时，发送完整 draft，不要只发摘要。

```text
请作为严格的 PM/工程 reviewer review 下面的 issue body draft。

重点检查 scope、non-goals、AC、依赖、风险、兼容性和可执行性。按严重程度列问题；
没有阻塞问题就明确说明可以推进。

--- issue draft ---
<完整文本>
```

多个 draft 应编号并分别使用清晰标题。

### 其他文本

设计文档、prompt、commit message 或其他独立文本应发送完整内容。长文本使用 `--file` 或 stdin，避免把大段 CJK 内容塞进 shell 参数。

## 独立讨论模式

当 workflow 明确要求，或实现路径具有高返工风险时，可以让 agent 和 relay 先独立分析再综合。适用场景包括 scope discovery、架构选型、public contract、migration、安全、并发和 test coverage。

### 两条 barrier

1. **Agent 在提交 relay 前不写实现观点。** 第一条 prompt 只包含任务、URL 和客观约束。
2. **Agent 在读取 relay 回复前必须把自己的结论写入可见 draft。** 不能只保留在内部推理中。

满足 barrier 后，agent 与 relay 应并行工作：

1. 使用 `--no-wait` 先提交 facts-only prompt，保存 `taskId`。
2. Agent 立即独立检查仓库并写出自己的 analysis 或 plan。
3. Agent draft 落盘后，使用 `gpt-relay show <taskId>` 或 API long poll 读取 relay 回复。
4. 比较 overlap、agent-only、relay-only 和实质冲突。
5. 只对关键差异继续讨论，最后形成一个 agent-owned synthesis。

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
gpt-relay show <taskId>
```

并行 discovery 不替代 artifact review。最终 issue body、implementation plan 或 PR 仍应进入对应的标准 review gate。

### 终止条件

- 已无阻塞决策或关键 blind spot。
- 新一轮没有增加实质论点。
- 剩余差异只是措辞、风格或可选 follow-up。
- 默认最多进行三轮追加讨论。

如果双方对产品、policy、UX、public contract 或 scope trade-off 仍有实质分歧，停止并把两份 rationale 交给用户。

### 不适合并行

- Context 尚未定型，需要先串行对齐事实。
- 流程本来就是 agent 先创建 artifact、relay 再 review artifact。
- 改动窄、路径明确且返工成本低。

## CLI 操作

### 提交并等待

```bash
gpt-relay review --session <task-session-id> --stdin
gpt-relay review --session <task-session-id> --file <prompt-file>
```

默认客户端等待 10 分钟，task 默认生命周期 30 分钟。`--wait-timeout` 只影响本次 CLI 等待；`--task-timeout` 才改变服务端 task deadline。完整语义见 [`api.md`](./api.md#timeout-与晚到回复)。

### 非阻塞提交

```bash
gpt-relay review --session <task-session-id> --stdin --no-wait
```

输出 machine-readable JSON：

```json
{"taskId":"...","status":"queued"}
```

### 查询、恢复和取消

```bash
gpt-relay tasks --session <task-session-id> --last 20
gpt-relay show <taskId>
gpt-relay resume
gpt-relay cancel <taskId>
```

CLI 会在 `~/.gpt-relay/pending/` 保存未完成 task 的本地记录。Agent 或 shell 中断后使用 `gpt-relay resume`，不要重复提交相同任务。

可能重试的调用应传 `--cri <stable-key>`。同一 session 下重复使用同一 key 会返回原 task，而不是创建副本。

## 多 session 并发

不同任务可以使用不同的用户指定 session 并发执行。每个 session 同时只处理一个 in-flight task。

不要：

- 给同一 session 并发提交多个当前任务。
- 因为另一个 session 空闲就把当前 workflow 切过去。
- 为同一 workflow 的不同 phase 临时更换 session。

## Failure handling

| Signal | Agent action |
|---|---|
| `gpt-relay health` 失败 | 请用户启动 `gpt-relay start` |
| 用户指定 session 不在列表 | 请用户打开对应 ChatGPT conversation 并确认 relay banner |
| Session paused / captcha / rate limit | 停止并转告 `pauseReason` |
| Client wait timeout | 保留 `taskId`，使用 `gpt-relay resume` 或 `show`；不要重新提交 |
| Task `failed/cancelled/expired` | 报告 error；若存在 late-reply window，后续用 `resume` 回收 |
| Relay 无法访问 URL | 补充必要的完整文本，或让用户处理授权 |
| 回复明显偏题 | 停止当前 review，补 context 或让用户确认 session |

单次 HTTP long poll 返回仍为 `queued` 或 `in_progress` 不表示 task 失败。协议状态和 late reply 规则见 [`api.md`](./api.md)。

## 反模式

- 把本地未 push diff 内联给 relay 做 PR review。
- 自行选择一个空闲或最近 session。
- 每轮重复完整仓库上下文。
- 只发 draft 摘要或“关键片段”。
- 用关键词匹配 relay 回复判断是否通过。
- Relay 一暂停就自动重试。
- 在读取 relay 独立输出后才补写所谓“agent 独立结论”。
- 一直讨论到“看起来完美”，而不是在无 blocking blind spot 时停止。
- 用 agent + relay 共识替代用户决策。
- 通过 `node -e`、密集 PowerShell quoting 或 shell history 传递大段 CJK 和敏感文本。

## 数据与隐私

Prompt 和 reply 持久化在本地 `~/.gpt-relay/gpt-relay.db`，pending 记录位于 `~/.gpt-relay/pending/`。内容会发送到用户自己的 ChatGPT tab。

不要发送用户未授权共享给 ChatGPT 的 secret、credential 或敏感数据。

## 相关文档

- [`api.md`](./api.md) — HTTP API、task lifecycle、timeouts 和环境变量
- [`workflows/README.md`](./workflows/README.md) — 多阶段 orchestration 入口
- [`README.md`](./README.md) — 项目安装、CLI 和扩展概览
- [`extension/README.md`](./extension/README.md) — 浏览器扩展加载与恢复机制
