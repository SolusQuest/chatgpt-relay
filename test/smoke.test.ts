// test/smoke.test.ts
// Smoke test: start the relay on test port 18766 and verify /health.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 18766; // Dedicated test port that avoids the development relay.
const BASE = `http://localhost:${PORT}`;

let child: ChildProcess | null = null;

async function waitForHealth(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy: ${String(lastErr)}`);
}

before(async () => {
  const entry = path.join(REPO_ROOT, 'server', 'index.ts');
  child = spawn(process.execPath, ['--import', 'tsx', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GPT_RELAY_PORT: String(PORT), GPT_RELAY_DATA_DIR: path.join(REPO_ROOT, ".test-data", "smoke") },
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (d) => process.stderr.write(`[srv] ${d}`));
  await waitForHealth();
});

after(() => {
  child?.kill();
});

test('GET /health returns ok', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; sessions: number };
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.sessions, 'number');
});

test('GET /v1/sessions returns array', async () => {
  const res = await fetch(`${BASE}/v1/sessions`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessions: unknown[] };
  assert.ok(Array.isArray(body.sessions));
});
