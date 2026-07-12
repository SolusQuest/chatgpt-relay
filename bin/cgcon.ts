#!/usr/bin/env node
// bin/cgcon.ts
// Phase 0 CLI: 只实现 start / health，Phase 1 起补齐 tasks/show/cancel/resume。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CGCON_PORT ?? 8766);
const BASE = `http://localhost:${PORT}`;

async function cmdStart(args: string[]): Promise<number> {
  const entry = path.join(REPO_ROOT, 'server', 'index.ts');
  const proc = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  return new Promise((resolve) => proc.on('exit', (code) => resolve(code ?? 0)));
}

async function cmdHealth(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/health`);
    const data = (await res.json()) as { status?: string; sessions?: number };
    if (data.status === 'ok') {
      console.log(`ok (${BASE}, sessions=${data.sessions ?? 0})`);
      return 0;
    }
    console.error(`unexpected response: ${JSON.stringify(data)}`);
    return 2;
  } catch (err) {
    console.error(`relay not reachable at ${BASE}: ${(err as Error).message}`);
    return 1;
  }
}

function usage(): void {
  console.log(`cgcon <command>

commands:
  start          start relay server (foreground)
  health         check relay health at ${BASE}

env:
  CGCON_PORT     server port (default 8766)
`);
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'start':
      return cmdStart(rest);
    case 'health':
      return cmdHealth();
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      return 64;
  }
}

main().then((code) => process.exit(code));