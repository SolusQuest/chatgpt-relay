# Migration: v2 (tampermonkey) → v3 (extension + SQLite)

## 变化总览

| 维度 | v2 | v3 |
|------|-----|-----|
| 浏览器端 | Tampermonkey userscript | Chrome MV3 扩展 |
| 服务端持久化 | 内存 Map | SQLite (`~/.cgcon/cgcon.db`) |
| API | `/task /reply /get_task /get_reply /session_status /heartbeat /sessions /health` | `/v1/tasks /v1/sessions /internal/*` + `/health` |
| 语言 | JavaScript (CJS) | TypeScript (ESM) + built Node 22+ |
| Task 模型 | 队列 + reply 队列 + activeTask 三份状态 | 单一 tasks 表 + 状态机 |
| 幂等 | 无 | `clientRequestId` |
| 长轮询 | 无（客户端 2s 短轮询） | 30s wait 支持 |
| 页面刷新丢结果 | 是 | 自动回捞 |
| 后台 tab | 常挂 | 双注入路径 + SW alarm |
| 断网恢复 | 需手动刷新 | 自动 detect + reload |
| CLI | 无 | `cgcon start/health/sessions/tasks/show/cancel/resume/review` |
| Skill | 无 | `skills/cgcon-review/` |

## Breaking changes

1. **端口不变（8765）**，但**数据格式不兼容**：v2 关服后重启到 v3 不会读旧数据。
2. **/task /get_reply /get_task /reply 等旧路由已删除**。仍使用旧 tampermonkey.js
   的用户必须切到新扩展。
3. Agent-client 从 CJS `require('./agent-client')` 改为 ESM
   `import { review } from 'cgcon/client/agent-client.js'`；或直接用 v1 REST。
4. Session id 语义不变（优先 conversation UUID），tab 存储 key 换成
   `cgcon_relay_session_id`（v2 是 `relay_session_id`）；页面刷新后可能生成新 id
   一次。

## 迁移步骤

对于已经在用 v2 的机器：

1. 停掉旧 relay：`Ctrl-C` 或 kill `node server.js`
2. 从 Tampermonkey 面板停用（**不必卸载**）旧 `ChatGPT Auto Relay` 脚本
3. 备份旧数据（如需）：v2 无持久化，队列本来就随进程走，无需备份
4. 切到新 worktree：`cd D:\code\cgcon-v3 && npm install && npm start`
5. `chrome://extensions/` 加载 `extension/` 目录
6. 刷新 chatgpt.com，看新绿色 banner
7. Agent 代码把 `require('.../agent-client.js')` 换成 v1 API 调用（或用 skill 里
   的 mjs 脚本）

## Rollback

如果 v3 出问题需要临时回滚：
1. 停 v3 relay
2. Chrome 扩展页把 v3 扩展停用
3. Tampermonkey 面板启用旧脚本
4. 到 `D:\code\cgcon` 主 worktree（未动过），`node server.js`

## Phase 时间线

- Phase 0: 目录 + TS 骨架
- Phase 1: SQLite + task 状态机 + v1 API + 旧 API shim
- Phase 2: agent-client v1 + skill 抽取
- Phase 3: 最小 MV3 扩展（功能对齐 tampermonkey）
- Phase 4: 后台 tab / 断网自愈 / 回复恢复
- Phase 5: 删旧代码 + 文档终态（本文件）

每个 Phase 一个 commit，详情 `git log --oneline`。

## 测试覆盖

`npm test`：57 个测试，覆盖：
- 21 单元测试（task-store 状态机全覆盖）
- 2 smoke（子进程起 server 打 /health）
- 13 v1 HTTP 集成（长轮询、pause 级联、幂等、recover）
- 3 recovery 端到端（DOM 回捞、requeue、race）
- 3 e2e fake extension（完整链路 + resume）
- 6 skill scripts（health/sessions/list/review/resume）
- 9 扩展静态验证（manifest 合法性、JS 语法、必需符号）

## 已知遗留

- LICENSE 文件未写（README 提到 MIT）
- 扩展图标是占位纯色 PNG
- 尚无 Web Store 发布，unpacked 分发
- 未做通知（`chrome.notifications` 权限已申请但未实现）
- Windows 上 SQLite WAL 文件在测试清理时偶发 EPERM，已加 try-catch 忽略