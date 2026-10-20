#!/usr/bin/env node
// Smoke test: starts the service with no external secrets (no DB, no API keys)
// and checks that GET /api/health answers {"status":"ok"}.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(process.env.SMOKE_PORT || 3999);
const url = `http://127.0.0.1:${port}/api/health`;

const child = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: port, HOST: '127.0.0.1', NODE_ENV: 'development' },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const stop = () => {
  if (!child.killed) child.kill('SIGTERM');
};

try {
  let lastError = 'no response';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      console.error(`smoke: server exited with code ${child.exitCode}`);
      console.error(stderr.trim().split('\n').slice(-6).join('\n'));
      process.exit(1);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      if (res.ok && body && body.status === 'ok') {
        console.log(`smoke: ${url} -> status=${body.status} database=${body.checks?.database}`);
        stop();
        process.exit(0);
      }
      lastError = `unexpected body: ${JSON.stringify(body).slice(0, 200)}`;
    } catch (err) {
      lastError = err.message;
    }
    await delay(250);
  }
  console.error(`smoke: health check failed: ${lastError}`);
  console.error(stderr.trim().split('\n').slice(-6).join('\n'));
  stop();
  process.exit(1);
} finally {
  stop();
}
