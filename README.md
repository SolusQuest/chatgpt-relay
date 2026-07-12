# cgcon — ChatGPT Relay

本地中继服务 + 浏览器扩展，让 AI coding agent 通过网页版 ChatGPT 做 code review /
决策 / 长文本审阅。零 API 费用，只吃 ChatGPT Plus 订阅额度。

## 特点

- **浏览器扩展控制页面**：真实浏览器环境，不易触发 ChatGPT 的自动化检测
- **多 session 并发**：同时开多个 chatgpt.com 标签页，多个 review 并行进行
- **SQLite 持久化 + 状态机**：所有 task 落盘，进程崩溃、页面刷新、浏览器重启后
  都能恢复；agent 中断后 `cgcon resume` 拿回结果
- **后台 tab 也能工作**：MV3 Service Worker + focus-independent 注入
- **断网自愈**：`fetch` hook + `online`/`offline` 事件，自动 reload
- **Agent 友好**：v1 REST API，长轮询、幂等、可批量、可回查

## 目录

```
cgcon-v3/
├── server/          Express + node:sqlite 中继服务
├── bin/cgcon.ts     CLI (start/health/tasks/show/cancel/sessions/resume/review)
├── client/          agent-client TS 库
├── extension/       Chrome MV3 扩展
├── skills/          Codex/Claude 用的 skill（HTTP-based, portable）
├── scripts/         杂项脚本
└── test/            单元 + 集成 + e2e 测试
```

## 快速开始

### 前置

- Node.js 22+（内置 `node:sqlite` 无需编译）
- Chrome / Edge / Brave（MV3 兼容）

### 1. 装依赖

```bash
cd D:\code\cgcon-v3
npm install
```

### 2. 起 relay

```bash
npm start
# 或全局：npm i -g . 后
cgcon start
```

默认监听 `127.0.0.1:8765`。数据在 `~/.cgcon/`。

### 3. 装扩展

`chrome://extensions/` → 开发者模式 → 加载已解压 → 选 `extension/`。

打开 chatgpt.com，页面顶部应出现绿色 `Relay: xxxxxxxx…` banner。

### 4. 发第一个 review

```bash
# 用 CLI
"这段代码看起来..." | cgcon review --session <session-id> --stdin

# 或直接调 API
curl -X POST http://127.0.0.1:8765/v1/tasks \
    -H "Content-Type: application/json" \
    -d '{"session":"<sid>","text":"..."}'
```

`<session-id>` 从 `cgcon sessions` 或扩展 popup 里看。

## 常用命令

```bash
cgcon start                                 # 起 relay
cgcon health                                # 检查是否可达
cgcon sessions                              # 列出活跃 chatgpt tab
cgcon tasks --last 20                       # 最近任务
cgcon show <taskId>                         # 查看完整 prompt/reply
cgcon cancel <taskId>                       # 取消
cgcon resume                                # 恢复上次中断的 taskId
cgcon review --session <id> --stdin         # 提交 review
```

## API 摘要

| Method | Path                                | 用途                            |
|--------|-------------------------------------|---------------------------------|
| POST   | /v1/tasks                           | 提交任务                        |
| GET    | /v1/tasks/:id?wait=30000            | 查询 / 长轮询到终态             |
| GET    | /v1/tasks?session=&status=&limit=   | 列表                            |
| DELETE | /v1/tasks/:id                       | 取消                            |
| GET    | /v1/sessions                        | 列 session                      |
| POST   | /v1/sessions/:id/pause              | 手动 pause                      |
| POST   | /v1/sessions/:id/resume             | 恢复                            |
| GET    | /health                             | 健康检查                        |

扩展端专用 `/internal/*` 见 `agent-instructions.md`。

## 环境变量

| 变量                        | 默认                          | 用途                    |
|-----------------------------|-------------------------------|-------------------------|
| `CGCON_PORT`                | `8765`                        | 监听端口                |
| `CGCON_HOST`                | `127.0.0.1`                   | 监听地址                |
| `CGCON_DATA_DIR`            | `~/.cgcon`                    | 数据目录                |
| `CGCON_DB_FILE`             | `~/.cgcon/cgcon.db`           | SQLite 文件             |
| `CGCON_DEFAULT_TIMEOUT_MS`  | `300000`                      | 单个 task 默认超时      |
| `CGCON_MAX_TASK_BYTES`      | `524288`                      | prompt 上限             |
| `CGCON_MAX_QUEUED_PER_SESSION` | `50`                       | 单 session 队列上限     |

## 测试

```bash
npm test                # 57 个测试（单元 + HTTP 集成 + e2e + skill + 扩展静态）
npm run typecheck       # tsc --noEmit
```

## 数据隐私

所有 prompt/reply 只存本地 `~/.cgcon/cgcon.db`。清理：

```bash
cgcon tasks --last 100        # 先看看
rm ~/.cgcon/cgcon.db*         # 全清
```

除了 relay ↔ 你自己的 ChatGPT tab 的通信，无任何数据外泄。

## 故障排查

| 症状                              | 排查                                                    |
|-----------------------------------|---------------------------------------------------------|
| `cgcon health` 失败               | 确认 `npm start` 或 `cgcon start` 在跑                   |
| 扩展 banner 不出现                | 刷新 chatgpt.com；`chrome://extensions/` 点扩展 Reload  |
| Popup 显示 unreachable            | 修改 popup 里的 Relay URL；防火墙                       |
| session paused                    | 看 popup 里 pauseReason；解决验证码/限速后自动恢复      |
| 文本注入失败                      | ChatGPT 前端改版，需要更新 `content-script.js` 选择器   |
| review 超时                       | 复杂 prompt 可能超 10 分钟；`cgcon resume` 事后拿结果   |

## 相关文档

- `agent-instructions.md` — 给 agent 直接看的 API 说明
- `skills/cgcon-review/SKILL.md` — Codex/Claude skill 定义
- `extension/README.md` — 扩展加载 + 恢复机制细节

## License

MIT (todo 一份 LICENSE 文件)。使用者自行遵守 OpenAI ToS。