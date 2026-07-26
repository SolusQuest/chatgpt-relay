 # 单 Session 真实 E2E 测试计划
 
 本计划覆盖一个 ChatGPT session/tab 下的核心行为。所有用例均在真实浏览器 + 真实 ChatGPT 页面 + 真实 Relay 服务端上执行。
 
 ---
 
 ## 前置条件
 
 1. 启动 Relay 服务端：`npm start` 或 `npx tsx server/index.ts`
 2. Chrome 已安装 gpt-relay 扩展，并指向正确的 `GPT_RELAY_URL`
 3. 有一个 `chatgpt.com` 标签页处于前台，session id 已知（如 `6a5383a5-c36c-83ee-a735-c7c0263cb82b`）
 4. 该 session 在服务端状态为 `paused: false`，无 inflight 任务
 5. 建议打开扩展 Service Worker 控制台和 ChatGPT 页面控制台，便于排错
 
 ---
 
 ## 用例清单
 
 | ID | 用例 | 优先级 | 对应 fate/单元测试 |
 |----|------|--------|-------------------|
 | SS-001 | 短文本基础 round-trip | P0 | `review round-trip via fake extension` |
 | SS-002 | 35k+ 长文本作为附件发送 | P0 | 长文本测试 |
 | SS-003 | 客户端 wait 超时后 resume 拿到回复 | P0 | `client wait timeout then resume gets reply` |
 | SS-004 | --no-wait 提交后通过 getTask/resume 查询 | P0 | `resume returns already-done task` |
 | SS-005 | 取消 queued 任务 | P1 | `cancel queued task prevents processing` |
 | SS-006 | 取消 in-progress 任务 | P1 | `cancel in-progress task` |
 | SS-007 | 短 timeout 任务过期 | P1 | `task expires when timeout is too short` |
 | SS-008 | 特殊字符与多行文本 | P1 | `special characters and multiline text` |
 | SS-009 | ChatGPT 页面刷新后 inflight recovery | P0 | `recover flow: task in_progress -> page reload` |
 | SS-010 | 扩展重新加载后恢复 | P0 | `fake extension recovers after restart` |
 | SS-011 | 网络离线后恢复 | P1 | `offline/online` handler |
 | SS-012 | Safety block 自动暂停 session | P1 | `pause via session_status` |
 | SS-013 | 任务失败后的重试 | P1 | `requeueTask over limit` |
 | SS-014 | 空文本/极短文本 | P2 | — |
 | SS-015 | 超长 timeout（5 分钟）任务 | P2 | — |
 
 ---
 
 ## SS-001 短文本基础 round-trip
 
 **目的**：验证最简单的端到端链路正常。
 
 **步骤**：
 1. 执行 `npx tsx bin/gpt-relay.ts review --session <sid> --text "hello" --wait-timeout 30000`
 2. 观察 CLI 输出
 3. 观察 ChatGPT 页面：prompt 被填入、点击发送、出现新 assistant 消息
 4. 观察 Relay bar 颜色变化：绿色 -> 橙色（处理中）-> 蓝色（等待回复）-> 绿色（完成）
 
 **预期结果**：
 - CLI 在合理时间内（< 30s）输出 ChatGPT 回复
 - 任务状态最终为 `done`
 - `submittedAt` 与 `dispatchedAt` 相差 < 1s（体现 long-poll 立即分发）
 
 **验收标准**：
 ```bash
 status=done
 reply 非空
 elapsed < 30000ms
 ```
 
 ---
 
 ## SS-002 35k+ 长文本作为附件发送
 
 **目的**：验证大文本能正确转为 ChatGPT 附件并返回结果。
 
 **步骤**：
 1. 生成 35k+ 文本：`"x" * 35000`
 2. 保存到文件 `long.txt`
 3. 执行 `npx tsx bin/gpt-relay.ts review --session <sid> --file long.txt --wait-timeout 120000`
 4. 观察 ChatGPT 页面：输入框出现 "粘贴的文本 (1)" 附件 chip，send 按钮 enabled 后自动点击
 
 **预期结果**：
 - 任务最终 `done`
 - 回复中明确提到收到长文本/附件
 - 总耗时可能在 10~30s（取决于上传和 ChatGPT 响应速度）
 
 **验收标准**：
 ```bash
 status=done
 reply 包含 "附件" 或 "文本" 或 "received" 等字样
 ```
 
 ---
 
 ## SS-003 客户端 wait 超时后 resume 拿到回复
 
 **目的**：验证客户端可以在等待超时断开后，后续再取回已经生成的回复。
 
 **步骤**：
 1. 向 ChatGPT 发送一个需要较长时间回复的 prompt，例如 `"请用 500 字总结机器学习的三个主要分支"`
 2. 客户端使用短 wait timeout：`--wait-timeout 3000`，预期 3 秒后超时退出
 3. 等待 ChatGPT 实际生成完回复（约 10~20s）
 4. 执行 `npx tsx bin/gpt-relay.ts resume`
 
 **预期结果**：
 - 步骤 2 中 CLI 抛出 timeout 错误
 - resume 命令显示任务为 `done` 并打印回复
 - pending 文件被清理
 
 **验收标准**：
 ```bash
 # resume 输出
 <taskId>\tdone\t"<prompt>"
 ─── reply ────────────────
 <ChatGPT 回复>
 ```
 
 ---
 
 ## SS-004 --no-wait 提交后通过 getTask/resume 查询
 
 **目的**：验证 `"fire and forget"` 模式工作正常。
 
 **步骤**：
 1. 执行 `npx tsx bin/gpt-relay.ts review --session <sid> --text "no wait test" --no-wait`
 2. 记录返回的 `taskId`
 3. 等待 10~20s
 4. 执行 `curl http://127.0.0.1:8765/v1/tasks/<taskId>` 或 `npx tsx bin/gpt-relay.ts show <taskId>`
 5. 执行 `npx tsx bin/gpt-relay.ts resume`
 
 **预期结果**：
 - 步骤 1 立即返回 `{"taskId":"...","status":"queued"}`
 - 步骤 4 显示 `status=done` 且有 reply
 - 步骤 5 显示相同结果并清理 pending
 
 ---
 
 ## SS-005 取消 queued 任务
 
 **目的**：验证在 extension 尚未领取任务前取消，任务不会被处理。
 
 **步骤**：
 1. 关闭/暂停目标 session 对应的扩展 loop（例如临时 popup-clear-inflight，或让 ChatGPT 页面不在前台）
 2. 执行 `npx tsx bin/gpt-relay.ts review --session <sid> --text "cancel me" --no-wait`，记录 taskId
 3. 立即执行 `npx tsx bin/gpt-relay.ts cancel <taskId>`
 4. 恢复 extension，等待 5s
 5. 查询 `npx tsx bin/gpt-relay.ts show <taskId>`
 
 **预期结果**：
 - 取消命令返回 `status=cancelled`
 - extension 恢复后没有发送该 prompt 到 ChatGPT
 - 任务状态保持 `cancelled`
 
 ---
 
 ## SS-006 取消 in-progress 任务
 
 **目的**：验证任务已被 extension 领取但还未完成时可以取消。
 
 **步骤**：
 1. 发送一个需要较长时间回复的 prompt
 2. 使用 `--no-wait` 提交，记录 taskId
 3. 立即观察任务被 claim（可通过 `/v1/tasks/<taskId>` 看到 `status=in_progress`）
 4. 执行 `npx tsx bin/gpt-relay.ts cancel <taskId>`
 5. 查询任务状态
 
 **预期结果**：
 - 取消命令成功
 - 任务最终 `status=cancelled`
 - ChatGPT 页面上的 inflight banner 被清除
 
 ---
 
 ## SS-007 短 timeout 任务过期
 
 **目的**：验证超过 timeout 的任务会被服务端标记为 expired。
 
 **步骤**：
 1. 关闭/暂停 extension，使任务无法被及时处理
 2. 执行 `npx tsx bin/gpt-relay.ts review --session <sid> --text "expire me" --no-wait --task-timeout 2000`
 3. 等待 5s 以上
 4. 查询任务状态
 
 **预期结果**：
 - 任务状态最终为 `expired`
 - `error` is `task_expired_before_dispatch`
 
 ---
 
 ## SS-008 特殊字符与多行文本
 
 **目的**：验证 Unicode、emoji、换行、HTML/XML、反斜杠等不会破坏注入或存储。
 
 **步骤**：
 1. 构造文本：`echo -e 'Hello 世界 🌍\nLine2\t"quoted" <html> & \\backslash\r\n日本語'`
 2. 通过 `--text` 或 `--file` 提交
 3. 观察 ChatGPT 收到的内容是否完整
 
 **预期结果**：
 - 任务 `done`
 - ChatGPT 收到的内容与提交内容一致
 - 回复正常
 
 ---
 
 ## SS-009 ChatGPT 页面刷新后 inflight recovery
 
 **目的**：验证任务发送后、生成过程中刷新页面，仍能通过 recovery 机制取回回复。
 
 **步骤**：
 1. 发送一个需要较长时间回复的 prompt
 2. 确认 Relay bar 变为蓝色（等待回复）
 3. 在 ChatGPT 页面按 F5 刷新
 4. 等待页面重新加载、生成继续
 5. 观察任务最终完成
 
 **预期结果**：
 - 刷新后 Relay bar 重新出现并继续显示等待状态
 - 任务最终 `done`
 - 不需要客户端重新提交
 
 ---
 
 ## SS-010 扩展重新加载后恢复
 
 **目的**：验证扩展 reload 后，已打开的 ChatGPT 页面能重新注入 content script，dispatch loop 能恢复。
 
 **步骤**：
 1. 在 `chrome://extensions` 点击扩展的 reload 按钮
 2. 刷新 ChatGPT 页面（MV3 reload 后 content script 需要重新注入）
 3. 发送一个短文本 prompt
 4. 观察任务是否成功完成
 
 **预期结果**：
 - 刷新后 session-hello 重新上报，SW 启动 dispatch loop
 - 新任务在 1s 内被 claim
 - 任务最终 `done`
 
 ---
 
 ## SS-011 网络离线后恢复
 
 **目的**：验证 ChatGPT 页面短暂断网时，任务不会被错误处理，恢复后继续。
 
 **步骤**：
 1. 发送一个 prompt
 2. 在 Chrome DevTools Network 面板选择 "Offline" 或断开 WiFi
 3. 等待 5s
 4. 恢复网络
 5. 观察任务是否最终完成
 
 **预期结果**：
 - 离线期间 SW 停止对应 session 的 dispatch loop
 - 恢复后 loop 重启，未完成任务继续处理
 - 任务最终 `done` 或合理失败
 
 ---
 
 ## SS-012 Safety block 自动暂停 session
 
 **目的**：验证 ChatGPT 出现 safety/captcha 等 block 时，session 被暂停，新任务会被拒绝。
 
 **步骤**：
 1. 触发一个会导致 ChatGPT 安全提示的 prompt（或使用测试环境模拟）
 2. 观察 Relay bar 变为紫色并显示暂停原因
 3. 尝试再提交一个新任务
 4. 解决 safety 问题后再次提交
 
 **预期结果**：
 - 出现 safety 提示后，服务端 session `paused=true`
 - 新任务提交返回 409 `session_paused`
 - 解决后 session 恢复，新任务可正常提交
 
 ---
 
 ## SS-013 任务失败后的重试
 
 **目的**：验证 run-task 失败（如 content script 临时无响应）后，任务会被 requeue 并再次尝试。
 
 **步骤**：
 1. 提交任务
 2. 在 run-task 执行瞬间临时禁用 content script（DevTools 中手动阻断，或刷新页面）
 3. 观察任务状态变化
 4. 等待恢复
 
 **预期结果**：
 - 失败时任务 `status` 可能短暂为 `failed` 或 `queued`（requeue）
 - 重试次数不超过配置值（默认 2 次）
 - 最终要么成功 `done`，要么彻底 `failed`
 
 ---
 
 ## SS-014 空文本/极短文本
 
 **目的**：验证边界输入不会导致注入或存储错误。
 
 **步骤**：
 1. 提交 `""`（应被服务端拒绝）
 2. 提交 `"hi"`
 3. 提交 `"?"`
 
 **预期结果**：
 - 空文本返回 400 `missing text`
 - 极短文本正常完成
 
 ---
 
 ## SS-015 超长 timeout（5 分钟）任务
 
 **目的**：验证长 timeout 不会提前过期，慢回复能正常拿到。
 
 **步骤**：
 1. 提交一个需要较长时间生成的复杂 prompt
 2. 使用 `--wait-timeout 300000 --task-timeout 300000`
 3. 等待 ChatGPT 完成
 
 **预期结果**：
 - 任务不会提前 expired
 - 最终 `done` 且有 reply
 
 ---
 
 ## 执行建议
 
 - 按 ID 顺序执行，SS-001/002/003/009/010 为回归必测项
 - 每次执行前确认服务端无残留 inflight：`npx tsx bin/gpt-relay.ts sessions`
 - 真实 ChatGPT 响应时间不稳定，timeout 建议留足余量
 - 失败时优先查看 Service Worker 控制台和 ChatGPT 页面控制台
