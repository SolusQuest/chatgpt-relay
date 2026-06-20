# ChatGPT Relay Agent 使用说明

> 将此文件内容粘贴给 AI coding agent，告诉它如何使用 ChatGPT Relay 工具。

## 前置条件

本机运行了一个 ChatGPT Relay 中继服务（`http://localhost:8765`），用于自动将内容发送给网页版 ChatGPT 并获取回复。

在 Node.js 环境中使用 `agent-client.js`：

```javascript
const { review, listSessions, getSessionStatus, healthCheck } = require('d:/code/cgcon/agent-client');
```

## 基本调用

首次使用前先确认服务和 ChatGPT 页面都在线：

```javascript
if (!(await healthCheck())) {
  throw new Error('Relay 服务未启动，请运行: cd d:/code/cgcon && node server.js');
}

const sessions = await listSessions();
if (sessions.length === 0) {
  throw new Error('没有活跃的 ChatGPT session，请打开 chatgpt.com 并确认 Tampermonkey 脚本已启用');
}

const readySession = sessions.find(s => !s.paused && !s.activeTaskId);
if (!readySession) {
  throw new Error(`没有可用的 ChatGPT session: ${JSON.stringify(sessions)}`);
}

const session = readySession.session;
```

发送 review 请求：

```javascript
const feedback = await review(prompt, {
  session,
  timeout: 180000
});
```

`prompt` 必须包含完整的 review 指令和待 review 内容。不要只发送一段裸文本让 ChatGPT 猜任务。

`listSessions()` 会返回每个 ChatGPT tab 的状态：

```javascript
[
  {
    session: '6a36ae0d-f3fc-83ee-9e94-d8df448e429d',
    pendingTasks: 0,
    activeTaskId: null,
    paused: false,
    pauseReason: null
  }
]
```

- `paused: true`：页面检测到验证码、rate limit、异常活动、访问受限等提示。agent 必须停止并提示用户处理页面。
- `activeTaskId` 非空：该 session 正在处理任务。agent 不要向同一个 session 并发发送新任务。
- `pendingTasks > 0`：已有排队任务。除非用户明确要求排队，否则优先选择空闲 session。

## 避免中文乱码

在 Windows/PowerShell/Claude Code 环境里，中文最容易在“命令行参数”这一层被错误编码。使用 relay 时遵守下面的规则：

1. 不要把大段中文直接塞进 `node -e "..."`、`curl` 参数或 shell 命令参数。
2. 优先从 UTF-8 文件读取正文，或在 Node.js 脚本中用普通字符串/模板字符串构造请求。
3. 如果必须在一行命令里构造中文测试文本，用 JavaScript Unicode 转义（例如 `\u4e2d\u6587`）避免 shell 编码干扰。
4. 调用 relay 时使用 `agent-client.review()`，不要手写没有 `charset=utf-8` 的 HTTP 请求。
5. 如果返回中出现 `�`、`Ã`、`Â` 等明显 mojibake 字符，先怀疑本地 shell/终端编码，不要直接认为 ChatGPT 或 relay 服务端改坏了文本。

推荐模式：

```javascript
const fs = require('node:fs/promises');
const { review } = require('d:/code/cgcon/agent-client');

const draft = await fs.readFile('issue-draft.md', 'utf8');
const feedback = await review(`请 review 下面的 issue body draft。\n\n${draft}`, { session });
```

## Review 类型 1：Issue Body Draft Review

当用户要求 review GitHub issue body draft 时，agent 必须发送完整文本给 ChatGPT。格式是：先给明确的 review prompt，再附上 draft 原文。

如果有多个 issue draft，一次请求里把所有 draft 都发给 ChatGPT，不要只发其中一个，也不要只发摘要。

示例：

```javascript
const prompt = `
请作为严格的 PM/工程 reviewer，review 下面的 GitHub issue body draft。

重点检查：
- 问题陈述是否清楚
- scope 是否过大或边界不清
- 验收标准是否可执行
- 依赖、风险、后续任务是否遗漏
- 是否存在含糊措辞、错误假设或需要补充的上下文

请按严重程度列出问题；如果没有阻塞问题，请明确说明可以继续推进，并给出可选改进建议。

## Issue Draft 1

${issueDraft1}

## Issue Draft 2

${issueDraft2}
`.trim();

const feedback = await review(prompt, { session, timeout: 180000 });
```

处理反馈时，agent 自己理解 ChatGPT 的意见并修改 draft。不要用关键词匹配来判断是否通过。

## Review 类型 2：Pull Request Review

当用户要求 ChatGPT review PR 时，不要把本地未提交 diff 直接发给 ChatGPT。标准流程是：

1. 确认本地改动范围。
2. 提交 commit。
3. push 到远端分支。
4. 创建或更新 GitHub PR。
5. 把 GitHub PR 链接发给 ChatGPT review。

发送给 ChatGPT 的内容应包含 review 要求和 PR 链接：

```javascript
const prompt = `
请作为严格的代码 reviewer，review 下面这个 GitHub PR。

重点检查：
- 行为是否符合需求
- 是否有 bug、边界条件、竞态或编码问题
- 测试覆盖是否足够
- 是否有不必要的复杂度或维护风险
- PR 描述和实现是否一致

请优先列出需要修改的问题；如果没有阻塞问题，请明确说明可以合并，并列出剩余风险。

PR: ${prUrl}
`.trim();

const feedback = await review(prompt, { session, timeout: 180000 });
```

如果 ChatGPT 指出需要修改的问题，agent 应修改代码、重新 commit/push，然后把同一个 PR 链接再次发给 ChatGPT 复审。

## 错误处理

- `healthCheck()` 失败：提示用户启动 relay 服务。
- `listSessions()` 为空：提示用户打开 ChatGPT 页面并确认 Tampermonkey 脚本启用。
- `review()` 超时：检查 ChatGPT 页面是否在生成、是否被 rate limit、session 是否还在线。
- 回复明显错位：检查是否有多个 agent 同时向同一个 session 发送任务；必要时重启 relay server 并刷新 ChatGPT 页面。
- 返回限制、验证码、异常活动或访问受限错误：停止自动操作，提示用户检查 ChatGPT 页面；不要尝试绕过、自动重试或切换账号。
- 返回 `Session paused`：不要重试同一任务，先让用户处理 ChatGPT 页面。页面恢复后再重新发起 review。
- 返回 `任务已过期`：说明任务排队太久没有被页面领取；重新确认 session 在线且空闲后，再由用户决定是否重发。
- 返回 `任务处理超时，已释放 session lock`：说明页面领取任务后长时间没有回包；检查页面是否卡住或刷新后再继续。

## 可靠性边界

Relay server 会做三类保护：

1. **Session lock**：同一个 session 同一时间只派发一个 active task。active task 未回复前，server 不会再给该页面派发新任务。
2. **Task TTL**：任务入队后如果超过 `timeout` 仍未被页面领取，会自动过期并返回错误，避免很久以后误处理旧任务。
3. **Paused status**：Tampermonkey 检测到验证码、rate limit、异常活动、访问受限等页面提示时，会上报 paused。server 会拒绝新任务，并把已排队或 active 的任务转成错误返回给 agent。

agent 必须把这些错误当成停止信号，不要自动绕过、自动切换账号、自动刷新重试或提高频率。

## 完整示例：Issue Draft Review

```javascript
const fs = require('node:fs/promises');
const { review, listSessions, healthCheck } = require('d:/code/cgcon/agent-client');

async function reviewIssueDrafts(paths) {
  if (!(await healthCheck())) {
    throw new Error('Relay 服务未启动，请运行: cd d:/code/cgcon && node server.js');
  }

  const sessions = await listSessions();
  if (sessions.length === 0) {
    throw new Error('没有活跃的 ChatGPT session，请打开 chatgpt.com 并确认 Tampermonkey 已启用');
  }

  const drafts = await Promise.all(
    paths.map(async (path, index) => {
      const body = await fs.readFile(path, 'utf8');
      return `## Issue Draft ${index + 1}: ${path}\n\n${body}`;
    })
  );

  const prompt = `
请作为严格的 PM/工程 reviewer，review 下面的 GitHub issue body draft。

请检查 scope、验收标准、依赖、风险、可执行性和上下文完整性。
请按严重程度列出问题；如果没有阻塞问题，请明确说明可以继续推进。

${drafts.join('\n\n---\n\n')}
`.trim();

  const readySession = sessions.find(s => !s.paused && !s.activeTaskId);
  if (!readySession) {
    throw new Error(`没有空闲的 ChatGPT session: ${JSON.stringify(sessions)}`);
  }

  return review(prompt, {
    session: readySession.session,
    timeout: 180000
  });
}
```

## 完整示例：PR Review

```javascript
const { review, listSessions, healthCheck } = require('d:/code/cgcon/agent-client');

async function reviewPullRequest(prUrl) {
  if (!(await healthCheck())) {
    throw new Error('Relay 服务未启动，请运行: cd d:/code/cgcon && node server.js');
  }

  const sessions = await listSessions();
  if (sessions.length === 0) {
    throw new Error('没有活跃的 ChatGPT session，请打开 chatgpt.com 并确认 Tampermonkey 已启用');
  }

  const prompt = `
请作为严格的代码 reviewer，review 下面这个 GitHub PR。

请优先检查 bug、边界条件、测试缺口、行为回归和维护风险。
如果没有阻塞问题，请明确说明可以合并，并列出剩余风险。

PR: ${prUrl}
`.trim();

  const readySession = sessions.find(s => !s.paused && !s.activeTaskId);
  if (!readySession) {
    throw new Error(`没有空闲的 ChatGPT session: ${JSON.stringify(sessions)}`);
  }

  return review(prompt, {
    session: readySession.session,
    timeout: 180000
  });
}
```
