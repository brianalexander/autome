#!/usr/bin/env tsx
/**
 * Unified startup script — launches all services needed for local development.
 *
 * Usage: npm start
 *
 * Starts:
 *   1. Backend API (:3001 — REST + WebSocket)
 *   2. Frontend (:5173 — Vite dev server)
 */

import { spawn, ChildProcess } from 'child_process';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Service {
  name: string;
  color: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  readyUrl?: string;
}

const services: Service[] = [
  {
    name: 'api',
    color: '\x1b[34m', // blue
    command: 'npx',
    args: ['tsx', 'watch', 'src/server.ts'],
    readyUrl: 'http://localhost:3001/api/health',
  },
  {
    name: 'frontend',
    color: '\x1b[32m', // green
    command: 'npm',
    args: ['run', 'dev', '--prefix', 'frontend'],
  },
];

const children: ChildProcess[] = [];

function log(name: string, color: string, message: string) {
  const label = `${color}${DIM}[${name}]${RESET}`;
  console.log(`${label} ${message}`);
}

function prefixStream(stream: NodeJS.ReadableStream, name: string, color: string) {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      if (line.trim()) {
        console.log(`${color}${DIM}[${name}]${RESET} ${line}`);
      }
      buffer = buffer.slice(newlineIdx + 1);
    }
  });
}

async function waitForUrl(url: string, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function startService(service: Service): ChildProcess {
  const proc = spawn(service.command, service.args, {
    cwd: service.cwd ?? process.cwd(),
    env: { ...process.env, ...service.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(proc.stdout!, service.name, service.color);
  prefixStream(proc.stderr!, service.name, service.color);

  proc.on('error', (err) => {
    log(service.name, service.color, `\x1b[31mFailed to start: ${err.message}${RESET}`);
    if (service.name === 'frontend' && err.message.includes('ENOENT')) {
      log(service.name, service.color, '\x1b[31mHint: try running `npm install` in the frontend directory\x1b[0m');
    }
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      log(service.name, service.color, `\x1b[31mExited with code ${code}\x1b[0m`);
    }
  });

  return proc;
}


function shutdown() {
  log('setup', '\x1b[36m', 'Shutting down...');
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  // Give processes a moment to exit gracefully, then force kill
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Main
console.log(`\n${BOLD}Starting autome development environment...${RESET}\n`);

// Build backend first — MCP servers are spawned as child processes from dist/
log('setup', '\x1b[36m', 'Building backend...');
const buildResult = spawn('npx', ['tsc', '-p', 'tsconfig.backend.json'], {
  cwd: process.cwd(),
  stdio: 'pipe',
});

await new Promise<void>((resolve) => {
  let stderr = '';
  buildResult.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  buildResult.on('exit', (code) => {
    if (code === 0) {
      log('setup', '\x1b[36m', `${BOLD}✓ Backend built${RESET}`);
    } else {
      log('setup', '\x1b[33m', `Build had warnings (exit ${code}) — continuing anyway`);
      if (stderr.trim()) {
        for (const line of stderr.trim().split('\n').slice(0, 5)) {
          log('setup', '\x1b[33m', `  ${line}`);
        }
      }
    }
    resolve();
  });
  buildResult.on('error', (err) => {
    log('setup', '\x1b[33m', `Build failed: ${err.message} — continuing with stale dist/`);
    resolve();
  });
});

for (const service of services) {
  const proc = startService(service);
  children.push(proc);
}
