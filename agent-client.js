const RELAY_URL = 'http://localhost:8765';
const DEFAULT_TIMEOUT = 180000;
const POLL_INTERVAL = 2000;

/**
 * 发送任务给 ChatGPT 并等待回复
 * @param {string} text - 要 review 的内容
 * @param {object} opts
 * @param {string} opts.session - 目标 session ID（从 ChatGPT URL 或 /sessions 获取）
 * @param {number} opts.timeout - 超时毫秒数，默认 180000 (3分钟)
 * @returns {Promise<string>} ChatGPT 的回复
 */
async function review(text, { session = 'default', timeout = DEFAULT_TIMEOUT } = {}) {
  // 1. 发送任务
  const sendRes = await fetch(`${RELAY_URL}/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, text, timeout })
  });

  if (!sendRes.ok) {
    const err = await sendRes.json();
    throw new Error(`发送任务失败: ${err.error}`);
  }

  const { taskId } = await sendRes.json();

  // 2. 轮询等待回复
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const res = await fetch(`${RELAY_URL}/get_reply?session=${session}&taskId=${taskId}`);
    const data = await res.json();

    if (data.text) return data.text;
    if (data.error) throw new Error(`ChatGPT 错误: ${data.error}`);

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error(`等待回复超时 (${timeout / 1000}s)`);
}

/**
 * 查询当前可用的 sessions（活跃的 ChatGPT 标签页）
 * @returns {Promise<Array<{session: string, pendingTasks: number}>>}
 */
async function listSessions() {
  const res = await fetch(`${RELAY_URL}/sessions`);
  const data = await res.json();
  return data.sessions;
}

/**
 * 健康检查
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  try {
    const res = await fetch(`${RELAY_URL}/health`);
    return (await res.json()).status === 'ok';
  } catch {
    return false;
  }
}

module.exports = { review, listSessions, healthCheck };
