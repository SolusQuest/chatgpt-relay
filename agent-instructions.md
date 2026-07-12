# cgcon v3 — Agent 使用指南

本文档给 AI coding agent 参考：如何通过本地 cgcon relay v3 让 ChatGPT web 端参与
代码 review / 决策 / 长文本审阅。

## 一句话

Relay 是一个 SQLite 队列服务，agent 提交 task → 浏览器扩展在 ChatGPT 页面执行 →
回复回写到 SQLite → agent 拉回。默认地址 `http://127.0.0.1:8765`，数据落在
`~/.cgcon/`。所有 task 落盘、可续、可回查。

## 何时用

用：
- 长文档、复杂设计、非 trivial refactor 需要"另一个模型"的意见
- 用户明确要求让 ChatGPT 看某段内容
- 高风险决策想交叉验证

不用：
- 简单的 self-review、格式化建议
- 处理敏感信息且用户未授权分享给 ChatGPT
- 用户明确指定了具体 API 模型（例如 gpt-4.1）

## 使用前检查

```bash
# 1. relay 是否在跑
curl -s http://127.0.0.1:8765/health
# → {"status":"ok","sessions":N}

# 2. 是否有活跃的 ChatGPT tab
curl -s http://127.0.0.1:8765/v1/sessions
# → {"sessions":[{"session":"...","paused":false,...}]}
```

如果第 1 步失败：让用户运行 `cgcon start` 或 `node server/index.ts`。
如果第 2 步 sessions=[]：让用户打开 chatgpt.com 并确认页面顶部绿色 banner。
如果所有 session 都 `paused:true`：把 pauseReason 告诉用户，让他解决验证码/限速。

## 提交 review（阻塞）

```bash
curl -s -X POST http://127.0.0.1:8765/v1/tasks \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{"session":"$SESSION_ID","text":"...prompt...","timeout":600000,
 "clientRequestId":"$(uuidgen)"}
EOF
# → {"taskId":"abc123","status":"queued"}

# 长轮询等结果（每次最多 wait 30000ms）
curl -s "http://127.0.0.1:8765/v1/tasks/abc123?wait=30000"
# → {"taskId":"...","status":"done","reply":"...","error":null,...}
```

推荐 wait chunk 30_000 ms，循环直到 status ∈ {done, failed, cancelled, expired}。

## 提交 review（非阻塞）

```bash
# 提交后立刻返回 taskId
curl -X POST .../v1/tasks -d '{"session":"...","text":"...","clientRequestId":"..."}'

# 随时查询（不 wait）
curl .../v1/tasks/<taskId>
```

适合：并行发多个 review 到不同 session、后续再统一收结果。

## 取消

```bash
curl -X DELETE http://127.0.0.1:8765/v1/tasks/<taskId>
```

queued task 立即变 cancelled；in_progress task 由扩展下次汇报时中止（best-effort）。

## 列出历史

```bash
curl "http://127.0.0.1:8765/v1/tasks?limit=20"
curl "http://127.0.0.1:8765/v1/tasks?session=$SID&status=done&limit=10"
```

## 状态含义

| status        | 含义                                                   |
|---------------|--------------------------------------------------------|
| `queued`      | 已入队等待扩展认领                                     |
| `in_progress` | 扩展已认领并正在与 ChatGPT 交互                        |
| `done`        | 成功，`reply` 字段有内容                               |
| `failed`      | 失败，`error` 字段有原因（含 session pause 级联失败） |
| `cancelled`   | agent 主动取消                                         |
| `expired`     | 入队后超过 timeout 都没被认领                          |

`done | failed | cancelled | expired` 统称 terminal，是"再也不会变"的最终状态。

## 幂等性

传 `clientRequestId`（推荐用 UUID）。同 session 内同 CRI 重复 POST 会返回**已有**
taskId，不产生新任务。用于网络重试、agent 崩溃后再次尝试。

## 错误码

| HTTP | 场景                          |
|------|-------------------------------|
| 400  | 字段缺失或非法                |
| 404  | taskId 不存在                 |
| 409  | session paused                |
| 413  | 单个 task text 超过 512 KB    |
| 429  | 单 session queued 超过 50 个  |

## 恢复中断的 task

如果 agent 崩溃/网络断/用户 Ctrl-C，只要记下过 taskId 就永远能找回：

```bash
# 服务端一直保存 task；查询即得
curl http://127.0.0.1:8765/v1/tasks/<taskId>
```

Node 里可以用 `client/agent-client.ts` 的 `resumePending()` 扫本地 pending 目录
一次性重连所有未完结的 task。

## 常见坑

1. **一定要传 session**：v3 强制 session id 有效（非空 ≤128 字符）。
2. **不要短轮询**：用 `?wait=30000` 让服务端挂起，客户端 CPU 空转是错误做法。
3. **taskId 是 UUID**：不要试图构造或猜 taskId。
4. **别混用旧 tampermonkey**：如果之前装过旧脚本，请在 Tampermonkey 面板停用后再用扩展。