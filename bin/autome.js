#!/usr/bin/env node

// Wrapper that re-execs with the tsx ESM loader so the CLI can
// dynamically import .ts plugin files (autome.plugins.ts).
// The actual CLI lives in dist/cli/index.js (compiled from src/).

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = resolve(__dirname, '../dist/cli/index.js');

try {
  execFileSync(process.execPath, ['--import', 'tsx/esm', cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
} catch (err) {
  // execFileSync throws on non-zero exit — just forward the exit code
  process.exit(err.status ?? 1);
}
