# cgcon — ChatGPT Relay

本地中继服务，让 AI coding agent 自动与网页版 ChatGPT 交互进行 review。

零额外 API 费用，仅使用 ChatGPT Plus 订阅额度。

## 快速开始

### 1. 安装依赖

```bash
cd d:/code/cgcon
npm install
```

### 2. 启动中继服务

```bash
node server.js
```

服务运行在 `http://localhost:8765`，保持终端开启。

### 3. 安装 Tampermonkey 脚本

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 新建脚本，将 `tampermonkey.js` 的内容粘贴进去并保存
3. 打开 `https://chatgpt.com`，确认页面顶部出现绿色 `Relay: xxxxxxxx...` 横幅

### 4. Agent 端使用

在 agent 项目中：

```javascript
const { review, listSessions, healthCheck } = require('d:/code/cgcon/agent-client');

// 检查服务
await healthCheck(); // → true

// 查看可用 session
await listSessions(); // → [{ session: "475daea1-...", pendingTasks: 0 }]

// 发送 review
const feedback = await review('这里是要 review 的内容...', { session: '目标session-id' });
```

也可以把 `agent-instructions.md` 的内容粘贴给 agent，让它知道如何调用。

## 架构

```
Agent ──POST /task──→ Server ──GET /get_task──→ Tampermonkey
  ↑                                                │
  └────── GET /get_reply ←── POST /reply ←─────────┘
```

- **Server** (`server.js`)：本地 HTTP 服务，管理任务队列和回复
- **Tampermonkey** (`tampermonkey.js`)：运行在 ChatGPT 页面，轮询任务、注入文本、提交回复
- **Agent Client** (`agent-client.js`)：Agent 端调用封装

## 多 Tab / 多 Session

每个 ChatGPT 标签页自动分配一个 session ID（优先用 URL 中的 conversation ID）。

```javascript
// 查看所有活跃 session
const sessions = await listSessions();

// 指定不同 session 给不同任务
await review(draftA, { session: sessions[0].session });
await review(draftB, { session: sessions[1].session });
```

## 故障排查

| 问题 | 排查 |
|------|------|
| healthCheck 返回 false | 确认 `node server.js` 在运行 |
| listSessions 返回空数组 | 确认 ChatGPT 页面已打开，Tampermonkey 脚本已启用，绿色横幅可见 |
| review() 超时 | 检查 ChatGPT 页面是否正常，是否有 rate limit 提示 |
| 文本注入失败 | ChatGPT 前端可能改版，检查 `tampermonkey.js` 中的选择器 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `server.js` | 中继服务，`node server.js` 启动 |
| `agent-client.js` | Agent 端模块，`require('./agent-client')` |
| `tampermonkey.js` | 油猴脚本，复制到 Tampermonkey |
| `agent-instructions.md` | Agent 使用说明，粘贴给 agent |
| `README.md` | 本文件 |
