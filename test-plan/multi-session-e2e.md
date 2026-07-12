 # 多 Session 真实 E2E 测试计划
 
 本计划覆盖多个 ChatGPT session/tab 同时存在时的并发、隔离、资源竞争行为。所有用例在真实浏览器 + 真实 ChatGPT 页面 + 真实 Relay 服务端上执行。
 
 ---
 
 ## 前置条件
 
 1. 启动 Relay 服务端
 2. 至少两个不同的 ChatGPT 标签页/对话处于前台，session id 分别为 `sid-A` 和 `sid-B`
 3. 两个 session 在服务端均为 `paused: false`，无 inflight 任务
 4. 扩展已启用并连接服务端
 
 ---
 
 ## 用例清单
 
 | ID | 用例 | 优先级 | 对应 fate/单元测试 |
 |----|------|--------|-------------------|
 | MS-001 | 两个 session 同时各提交一个任务 | P0 | `two sessions run in parallel` |
 | MS-002 | 两个 session 同时各提交多个任务 | P0 | `multiple tasks per session in parallel across sessions` |
 | MS-003 | 一个 session paused 不影响另一个 | P1 | `pause via session_status` |
 | MS-004 | 一个 session 失败/离线不影响另一个 | P1 | `offline/online` handler |
 | MS-005 | 多 session 下取消指定任务 | P1 | `cancelTask` |
 | MS-006 | 同 session 多个 tab 只有一个处理任务 | P1 | `startDispatchLoop` 去重 |
 | MS-007 | session URL 变化后旧 loop 停止、新 loop 启动 | P1 | `forgetTabSession` + `session-hello` |
 | MS-008 | 多 session 长文本附件并发 | P2 | 长文本测试 + 多 session 并行 |
 | MS-009 | 多 session 下客户端超时后 resume | P2 | `client wait timeout then resume` |
 | MS-010 | 服务端重启后多 session 恢复 | P2 | `restoreDispatchLoops` + alarm |
 
 ---
 
 ## MS-001 两个 session 同时各提交一个任务
 
 **目的**：验证每个 session 有独立 dispatch loop，互不阻塞。
 
 **步骤**：
 1. 在终端 A 执行：`npx tsx bin/gpt-relay.ts review --session <sid-A> --text "task A" --timeout 30000`
 2. 在终端 B 同时执行：`npx tsx bin/gpt-relay.ts review --session <sid-B> --text "task B" --timeout 30000`
 3. 观察两个 ChatGPT 页面是否几乎同时开始处理
 
 **预期结果**：
 - 两个任务最终都 `done`
 - 两个任务的 `dispatchedAt` 都接近 `submittedAt`
 - 总耗时取决于各自 ChatGPT 响应速度，而不是 A 等 B
 
 **验收标准**：
 ```bash
 task-A.status == done
 task-B.status == done
 task-A.dispatchedAt - task-A.submittedAt < 2000ms
 task-B.dispatchedAt - task-B.submittedAt < 2000ms
 ```
 
 ---
 
 ## MS-002 两个 session 同时各提交多个任务
 
 **目的**：验证多任务在多 session 下能正确排队和并行处理。
 
 **步骤**：
 1. 向 session A 连续提交 3 个任务：`task-A0`、`task-A1`、`task-A2`
 2. 同时向 session B 连续提交 3 个任务：`task-B0`、`task-B1`、`task-B2`
 3. 所有任务使用 `--no-wait` 或较长 timeout
 4. 等待所有任务完成
 5. 查询任务列表：`npx tsx bin/gpt-relay.ts tasks --last 20`
 
 **预期结果**：
 - 6 个任务最终全部 `done`
 - 每个 session 内部按 FIFO 顺序处理
 - 两个 session 的处理进度互不干扰
 
 **验收标准**：
 ```bash
 6 tasks status == done
 task-A0.completedAt < task-A1.completedAt < task-A2.completedAt
 task-B0.completedAt < task-B1.completedAt < task-B2.completedAt
 ```
 
 ---
 
 ## MS-003 一个 session paused 不影响另一个
 
 **目的**：验证 session 级别的 pause 隔离。
 
 **步骤**：
 1. 对 session A 调用暂停 API：`curl -X POST http://127.0.0.1:8765/internal/sessions/<sid-A>/status -H "Content-Type: application/json" -d '{"paused":true,"reason":"test"}'`
 2. 向 session A 提交任务，应失败
 3. 向 session B 提交任务，应成功
 4. 恢复 session A：`curl -X POST ... -d '{"paused":false}'`
 5. 再次向 session A 提交任务，应成功
 
 **预期结果**：
 - session A 暂停期间新任务返回 409 `session_paused`
 - session B 全程不受影响
 - 恢复后 session A 可继续处理
 
 ---
 
 ## MS-004 一个 session 失败/离线不影响另一个
 
 **目的**：验证一个 session 的 tab 离线或 content script 崩溃不会拖垮其他 session。
 
 **步骤**：
 1. 让 session A 的 ChatGPT 页面进入离线状态（DevTools Network Offline）
 2. 向 session A 提交任务
 3. 向 session B 提交任务
 4. 恢复 session A 网络
 5. 等待一段时间
 
 **预期结果**：
 - session B 的任务正常完成
 - session A 的任务可能失败或重新排队
 - 恢复网络后，session A 的 loop 重启，后续任务正常
 
 ---
 
 ## MS-005 多 session 下取消指定任务
 
 **目的**：验证取消只影响目标 task，不影响同 session 或其他 session 的任务。
 
 **步骤**：
 1. 向 session A 提交 2 个任务：`A1`、`A2`
 2. 向 session B 提交 2 个任务：`B1`、`B2`
 3. 取消 `A2`
 4. 等待剩余任务完成
 
 **预期结果**：
 - `A2` 状态为 `cancelled`
 - `A1`、`B1`、`B2` 正常 `done`
 
 ---
 
 ## MS-006 同 session 多个 tab 只有一个处理任务
 
 **目的**：验证 `startDispatchLoop` 以 session 为 key 去重，避免重复领取任务。
 
 **步骤**：
 1. 打开两个不同的 ChatGPT 对话，但让它们具有相同 session id（例如复制对话链接）
 2. 或者更简单地：打开两个 chatgpt.com 标签页，观察 content-script 上报的 session id
 3. 向该 session 提交一个任务
 4. 观察两个 tab 的 Relay bar 和页面行为
 
 **预期结果**：
 - 只有一个 tab 实际注入并发送 prompt
 - 另一个 tab 保持空闲
 - 任务只完成一次，不会重复
 
 ---
 
 ## MS-007 session URL 变化后旧 loop 停止、新 loop 启动
 
 **目的**：验证 tab URL 变化（session id 变化）时，旧 loop 停止，新 session 启动新 loop。
 
 **步骤**：
 1. 在 ChatGPT 页面从一个对话导航到另一个对话（URL `/c/<old>` -> `/c/<new>`）
 2. 观察 content-script 重新上报 session id
 3. 向新 session 提交任务
 4. 向旧 session 提交任务
 
 **预期结果**：
 - 新 session 的任务被新 tab 处理
 - 旧 session 的任务如果没有 tab 对应，会进入 queued 等待或最终 expired
 - 旧 loop 已停止，不会占用资源
 
 ---
 
 ## MS-008 多 session 长文本附件并发
 
 **目的**：验证多个 session 同时上传大附件不会互相阻塞。
 
 **步骤**：
 1. 准备两份 35k+ 文本
 2. 同时向 session A 和 session B 提交 `--file` 任务
 3. 使用 `--timeout 120000`
 4. 等待两个任务都完成
 
 **预期结果**：
 - 两个任务都 `done`
 - 两个页面都正确显示附件 chip
 - 总耗时与单 session 长文本测试相近
 
 ---
 
 ## MS-009 多 session 下客户端超时后 resume
 
 **目的**：验证多 session 场景下，每个 session 的 pending 记录独立，resume 互不干扰。
 
 **步骤**：
 1. 向 session A 发送慢 prompt，timeout 3s，使其超时
 2. 向 session B 发送慢 prompt，timeout 3s，使其超时
 3. 等待两个任务都实际完成
 4. 执行 `npx tsx bin/gpt-relay.ts resume`
 
 **预期结果**：
 - resume 显示两个 `done` 任务
 - 两个回复分别对应各自的 session
 - pending 文件全部清理
 
 ---
 
 ## MS-010 服务端重启后多 session 恢复
 
 **目的**：验证服务端重启后，所有 session 的 dispatch loop 能被 alarm 恢复。
 
 **步骤**：
 1. 确保 session A 和 B 的 tab 都在前台
 2. 重启 Relay 服务端进程
 3. 等待 1 分钟（让 chrome alarm 触发 `restoreDispatchLoops`）
 4. 或者手动点击扩展 popup 的 "Poll now" 按钮
 5. 向两个 session 各提交一个任务
 
 **预期结果**：
 - 重启后两个 session 重新出现心跳/lastSeen
 - 新任务被及时 claim
 - 两个任务都 `done`
 
 ---
 
 ## 执行建议
 
 - 优先执行 MS-001/002/003/004
 - 多 session 测试前，先用 `npx tsx bin/gpt-relay.ts sessions` 确认两个 session 都活跃
 - 为避免 ChatGPT 风控，真实浏览器测试建议控制并发频率
 - 失败时优先查看 Service Worker 控制台和每个 ChatGPT 页面控制台
