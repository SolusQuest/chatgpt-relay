const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

// session_id → { taskQueue: [], replyQueue: [], lastSeen: number }
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { taskQueue: [], replyQueue: [], lastSeen: Date.now() });
  }
  return sessions.get(id);
}

// ── Agent 端接口 ──

// Agent 推送任务到指定 session
app.post('/task', (req, res) => {
  const { session, text, timeout = 180000 } = req.body;
  if (!session || !text) {
    return res.status(400).json({ error: 'Missing session or text' });
  }
  const s = getSession(session);
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  s.taskQueue.push({ taskId, text, timeout, createdAt: Date.now() });
  console.log(`[${session}] 任务入队 ${taskId}, 长度 ${text.length}`);
  res.json({ status: 'ok', taskId });
});

// Agent 轮询回复
app.get('/get_reply', (req, res) => {
  const { session, taskId } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  if (s.replyQueue.length > 0) {
    // 有 taskId 时在队列中查找匹配项，无 taskId 时取第一个
    const idx = taskId
      ? s.replyQueue.findIndex(r => r.taskId === taskId)
      : 0;
    if (idx >= 0) {
      const [reply] = s.replyQueue.splice(idx, 1);
      return res.json({ text: reply.text, taskId: reply.taskId, error: reply.error });
    }
  }
  res.json({ text: null });
});

// Agent 查询可用 sessions
app.get('/sessions', (req, res) => {
  const now = Date.now();
  const result = [];
  for (const [id, s] of sessions) {
    if (now - s.lastSeen < 30000) {
      result.push({ session: id, pendingTasks: s.taskQueue.length });
    }
  }
  res.json({ sessions: result });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// Tampermonkey loader 动态加载本地脚本
app.get('/tampermonkey.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(__dirname, 'tampermonkey.js'));
});

// ── 扩展端接口 ──

// 扩展轮询获取任务
app.get('/get_task', (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  s.lastSeen = Date.now();
  if (s.taskQueue.length > 0) {
    const task = s.taskQueue.shift();
    console.log(`[${session}] 任务取出 ${task.taskId}`);
    return res.json({ taskId: task.taskId, text: task.text });
  }
  res.json({ taskId: null, text: null });
});

// 扩展提交回复
app.post('/reply', (req, res) => {
  const { session, taskId, text, error } = req.body;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  s.lastSeen = Date.now();
  if (error) {
    console.log(`[${session}] 扩展报错: ${error}`);
    s.replyQueue.push({ taskId, text: null, error });
  } else {
    console.log(`[${session}] 回复入队 ${taskId}, 长度 ${text?.length}`);
    s.replyQueue.push({ taskId, text });
  }
  res.json({ status: 'ok' });
});

const PORT = 8765;
app.listen(PORT, () => {
  console.log(`ChatGPT Relay 已启动: http://localhost:${PORT}`);
});
