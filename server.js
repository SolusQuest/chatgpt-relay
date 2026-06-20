const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '1mb' }));

const DEFAULT_TIMEOUT = 300000;
const SESSION_ACTIVE_MS = 30000;
const ACTIVE_TASK_GRACE_MS = 30000;
const HEARTBEAT_STALE_MS = 60000;

// session_id → relay session state
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, createSession());
  }
  const s = sessions.get(id);
  ensureSessionShape(s);
  return s;
}

function createSession() {
  return {
    taskQueue: [],
    replyQueue: [],
    lastSeen: Date.now(),
    lastStatusAt: null,
    activeTask: null,
    activeTaskId: null,
    activeSince: null,
    activeDeadline: null,
    paused: false,
    pauseReason: null,
    pausedAt: null
  };
}

function ensureSessionShape(s) {
  s.taskQueue ||= [];
  s.replyQueue ||= [];
  s.lastSeen ||= Date.now();
  s.lastStatusAt ||= null;
  s.activeTask ||= null;
  s.activeTaskId ||= null;
  s.activeSince ||= null;
  s.activeDeadline ||= null;
  s.paused ||= false;
  s.pauseReason ||= null;
  s.pausedAt ||= null;
}

function normalizeTimeout(timeout) {
  const n = Number(timeout);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.max(1000, n);
}

function pushTaskError(sessionId, s, taskId, error) {
  if (!taskId) return;
  console.log(`[${sessionId}] 任务失败 ${taskId}: ${error}`);
  s.replyQueue.push({ taskId, text: null, error });
}

function clearActiveTask(s) {
  s.activeTask = null;
  s.activeTaskId = null;
  s.activeSince = null;
  s.activeDeadline = null;
}

function expireQueuedTasks(sessionId, s, now = Date.now()) {
  if (s.taskQueue.length === 0) return;
  const remaining = [];
  for (const task of s.taskQueue) {
    if (task.expiresAt <= now) {
      pushTaskError(sessionId, s, task.taskId, `任务已过期，未发送到页面 (${task.timeout / 1000}s)`);
    } else {
      remaining.push(task);
    }
  }
  s.taskQueue = remaining;
}

function releaseStaleActiveTask(sessionId, s, now = Date.now()) {
  if (!s.activeTask || !s.activeDeadline || s.activeDeadline > now) return;
  pushTaskError(sessionId, s, s.activeTaskId, `任务处理超时，已释放 session lock`);
  clearActiveTask(s);
}

function releaseHeartbeatLostTask(sessionId, s, now = Date.now()) {
  if (!s.activeTask || now - s.lastSeen <= HEARTBEAT_STALE_MS) return;
  pushTaskError(sessionId, s, s.activeTaskId, `Session 心跳丢失 (${Math.round((now - s.lastSeen) / 1000)}s 未响应)，可能已关闭或崩溃`);
  clearActiveTask(s);
}

function maintainSession(sessionId, s, now = Date.now()) {
  expireQueuedTasks(sessionId, s, now);
  releaseStaleActiveTask(sessionId, s, now);
  releaseHeartbeatLostTask(sessionId, s, now);
}

function failPendingTasks(sessionId, s, error) {
  if (s.activeTaskId) {
    pushTaskError(sessionId, s, s.activeTaskId, error);
    clearActiveTask(s);
  }
  for (const task of s.taskQueue) {
    pushTaskError(sessionId, s, task.taskId, error);
  }
  s.taskQueue = [];
}

function sessionSnapshot(id, s, now = Date.now()) {
  return {
    session: id,
    pendingTasks: s.taskQueue.length,
    activeTaskId: s.activeTaskId,
    activeSince: s.activeSince,
    activeForMs: s.activeSince ? now - s.activeSince : 0,
    paused: s.paused,
    pauseReason: s.pauseReason,
    pausedAt: s.pausedAt,
    lastSeen: s.lastSeen,
    lastStatusAt: s.lastStatusAt
  };
}

// ── Agent 端接口 ──

// Agent 推送任务到指定 session
app.post('/task', (req, res) => {
  const { session, text, timeout = DEFAULT_TIMEOUT } = req.body;
  if (!session || !text) {
    return res.status(400).json({ error: 'Missing session or text' });
  }
  const s = getSession(session);
  maintainSession(session, s);
  if (s.paused) {
    return res.status(409).json({ error: `Session paused: ${s.pauseReason || 'unknown reason'}` });
  }
  const timeoutMs = normalizeTimeout(timeout);
  const createdAt = Date.now();
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  s.taskQueue.push({
    taskId,
    text,
    timeout: timeoutMs,
    createdAt,
    expiresAt: createdAt + timeoutMs
  });
  console.log(`[${session}] 任务入队 ${taskId}, 长度 ${text.length}`);
  res.json({ status: 'ok', taskId });
});

// Agent 轮询回复
app.get('/get_reply', (req, res) => {
  const { session, taskId } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  maintainSession(session, s);
  if (s.paused && taskId) {
    const queuedIdx = s.taskQueue.findIndex(t => t.taskId === taskId);
    if (queuedIdx >= 0) {
      const [task] = s.taskQueue.splice(queuedIdx, 1);
      pushTaskError(session, s, task.taskId, `Session paused: ${s.pauseReason || 'unknown reason'}`);
    }
  }
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
  res.json({
    text: null,
    paused: s.paused,
    pauseReason: s.pauseReason,
    activeTaskId: s.activeTaskId
  });
});

// Agent 查询可用 sessions
app.get('/sessions', (req, res) => {
  const now = Date.now();
  const result = [];
  for (const [id, s] of sessions) {
    ensureSessionShape(s);
    maintainSession(id, s, now);
    if (now - s.lastSeen < SESSION_ACTIVE_MS) {
      result.push(sessionSnapshot(id, s, now));
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

// 心跳：只更新 lastSeen，不修改 paused 状态
app.post('/heartbeat', (req, res) => {
  const { session } = req.body;
  if (typeof session !== 'string' || session.length === 0 || session.length > 128) {
    return res.status(400).json({ error: 'Invalid session' });
  }
  const s = getSession(session);
  s.lastSeen = Date.now();
  res.json({ status: 'ok' });
});

// ── 扩展端接口 ──

// 扩展轮询获取任务
app.get('/get_task', (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  s.lastSeen = Date.now();
  maintainSession(session, s, s.lastSeen);
  if (s.paused) {
    return res.json({
      taskId: null,
      text: null,
      paused: true,
      pauseReason: s.pauseReason
    });
  }
  if (s.activeTaskId) {
    return res.json({
      taskId: null,
      text: null,
      activeTaskId: s.activeTaskId
    });
  }
  if (s.taskQueue.length > 0) {
    const task = s.taskQueue.shift();
    s.activeTask = task;
    s.activeTaskId = task.taskId;
    s.activeSince = Date.now();
    s.activeDeadline = s.activeSince + task.timeout + ACTIVE_TASK_GRACE_MS;
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
  maintainSession(session, s, s.lastSeen);
  if (taskId && s.activeTaskId === taskId) {
    clearActiveTask(s);
  } else if (taskId && s.activeTaskId) {
    console.warn(`[${session}] 收到非当前 active task 回复 ${taskId}, 当前 active: ${s.activeTaskId}`);
  }
  if (error) {
    console.log(`[${session}] 扩展报错: ${error}`);
    s.replyQueue.push({ taskId, text: null, error });
  } else {
    console.log(`[${session}] 回复入队 ${taskId}, 长度 ${text?.length}`);
    s.replyQueue.push({ taskId, text });
  }
  res.json({ status: 'ok' });
});

// 扩展上报 session 状态，例如验证码、rate limit、异常活动等暂停原因
app.post('/session_status', (req, res) => {
  const { session, paused = false, reason = null } = req.body;
  if (!session) return res.status(400).json({ error: 'Missing session' });
  const s = getSession(session);
  const now = Date.now();
  s.lastSeen = now;
  s.lastStatusAt = now;
  maintainSession(session, s, now);

  if (paused) {
    const pauseReason = reason || 'ChatGPT 页面暂停自动操作';
    const wasPaused = s.paused;
    s.paused = true;
    s.pauseReason = pauseReason;
    s.pausedAt ||= now;
    failPendingTasks(session, s, `Session paused: ${pauseReason}`);
    if (!wasPaused) {
      console.warn(`[${session}] session 暂停: ${pauseReason}`);
    }
  } else {
    if (s.paused) {
      console.log(`[${session}] session 恢复`);
    }
    s.paused = false;
    s.pauseReason = null;
    s.pausedAt = null;
  }

  res.json({ status: 'ok', session: sessionSnapshot(session, s, now) });
});

// 413 error handler
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 1MB limit' });
  }
  next(err);
});

const PORT = 8765;
app.listen(PORT, () => {
  console.log(`ChatGPT Relay 已启动: http://localhost:${PORT}`);
});
