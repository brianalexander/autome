#!/usr/bin/env node
/**
 * Entry point for the `autome` CLI.
 *
 * Commands:
 *   autome [start]     Start the server (default)
 *   autome doctor      Environment checks
 *
 * Options:
 *   --port <n>         Override port
 *   --host <h>         Override host
 *   --data-dir <path>  Override data directory
 *   --open             Auto-open browser on start
 *   --no-open          Don't open browser (default)
 *   --verbose          Verbose logging
 *   -h, --help         Show help
 *   -v, --version      Show version
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config/loader.js';
import type { AutomeConfig } from '../config/types.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: 'start' | 'doctor';
  port?: number;
  host?: string;
  dataDir?: string;
  open: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script
  const result: ParsedArgs = {
    command: 'start',
    open: false,
    verbose: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === 'start' || arg === 'doctor') {
      result.command = arg;
    } else if (arg === '--port' || arg === '-p') {
      result.port = parseInt(args[++i] ?? '', 10);
    } else if (arg === '--host') {
      result.host = args[++i];
    } else if (arg === '--data-dir') {
      result.dataDir = args[++i];
    } else if (arg === '--open') {
      result.open = true;
    } else if (arg === '--no-open') {
      result.open = false;
    } else if (arg === '--verbose') {
      result.verbose = true;
    } else if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-v' || arg === '--version') {
      result.version = true;
    }
    i++;
  }

  return result;
}

function showHelp() {
  console.log(`
Usage: autome [command] [options]

Commands:
  start          Start the server (default)
  doctor         Run environment checks

Options:
  --port <n>         Override server port (default: 3001)
  --host <h>         Override bind host (default: 127.0.0.1)
                     Use 0.0.0.0 to expose on LAN
  --data-dir <path>  Override data directory (default: ./data)
  --open             Auto-open browser after start
  --no-open          Don't open browser (default)
  --verbose          Verbose logging (prints resolved config)
  -h, --help         Show this help
  -v, --version      Show version
`);
}

function showVersion() {
  console.log('autome 0.1.0');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart(args: ParsedArgs) {
  const overrides: Partial<AutomeConfig> = {};
  if (args.port && !isNaN(args.port)) overrides.port = args.port;
  if (args.host) overrides.host = args.host;
  if (args.dataDir) overrides.dataDir = args.dataDir;
  if (args.open) overrides.openBrowser = true;

  const resolvedConfig = await loadConfig(overrides);

  if (args.verbose) {
    console.log('[autome] Resolved config:', resolvedConfig);
  }

  // Production mode: warn if the frontend wasn't built
  if (resolvedConfig.mode === 'production') {
    const frontendDistIndex = resolve(__dirname, '../../frontend/dist/index.html');
    if (!existsSync(frontendDistIndex)) {
      console.log(
        '[autome] Production mode: frontend not built. Run `npm run build:all` and try again.\n' +
          '         Starting in API-only mode.',
      );
    }
  }

  console.log(
    `[autome] Starting server on ${resolvedConfig.host}:${resolvedConfig.port} (mode: ${resolvedConfig.mode})`,
  );

  const { startServer } = await import('../server-start.js');
  await startServer(resolvedConfig);

  if (resolvedConfig.openBrowser) {
    const url = `http://${resolvedConfig.host === '0.0.0.0' ? 'localhost' : resolvedConfig.host}:${resolvedConfig.port}`;
    await openBrowser(url);
  }
}

async function cmdDoctor(_args: ParsedArgs) {
  const checks: Array<{ label: string; pass: boolean; detail?: string }> = [];

  // 1. Node version >= 20
  const [major] = process.versions.node.split('.').map(Number);
  checks.push({
    label: `Node.js >= 20 (found ${process.versions.node})`,
    pass: major >= 20,
  });

  // 2. Load config
  let resolvedConfig;
  try {
    resolvedConfig = await loadConfig();
  } catch (err) {
    checks.push({ label: 'Config loads without error', pass: false, detail: String(err) });
    printDoctorTable(checks);
    return;
  }
  checks.push({ label: 'Config loads without error', pass: true });

  // 3. DB directory writable
  try {
    const dbDir = dirname(resolvedConfig.databasePath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const { accessSync, constants } = await import('node:fs');
    accessSync(dbDir, constants.W_OK);
    checks.push({ label: `DB dir writable (${dbDir})`, pass: true });
  } catch (err) {
    checks.push({
      label: `DB dir writable (${resolvedConfig.databasePath})`,
      pass: false,
      detail: String(err),
    });
  }

  // 4. Plugins load without error
  try {
    const { loadPlugins } = await import('../plugin/loader.js');
    await loadPlugins();
    checks.push({ label: 'Plugins load without error', pass: true });
  } catch (err) {
    checks.push({ label: 'Plugins load without error', pass: false, detail: String(err) });
  }

  // 5. ACP provider CLI on PATH
  if (resolvedConfig.acpProvider) {
    const cliMap: Record<string, string> = {
      kiro: 'kiro-cli',
      opencode: 'opencode',
      'claude-code': 'claude',
    };
    const cliName = cliMap[resolvedConfig.acpProvider] ?? resolvedConfig.acpProvider;
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      await execAsync(`${whichCmd} ${cliName}`);
      checks.push({ label: `ACP provider CLI '${cliName}' on PATH`, pass: true });
    } catch {
      checks.push({
        label: `ACP provider CLI '${cliName}' on PATH`,
        pass: false,
        detail: 'not found in PATH',
      });
    }
  } else {
    checks.push({
      label: 'ACP provider CLI',
      pass: true,
      detail: 'none configured (will use default)',
    });
  }

  printDoctorTable(checks);
}

function printDoctorTable(checks: Array<{ label: string; pass: boolean; detail?: string }>) {
  console.log('\nautome doctor\n');
  for (const check of checks) {
    const icon = check.pass ? '\u2713' : '\u2717';
    const line = `  ${icon}  ${check.label}`;
    console.log(line + (check.detail ? `  (${check.detail})` : ''));
  }
  const allPassed = checks.every((c) => c.pass);
  console.log(allPassed ? '\nAll checks passed.' : '\nSome checks failed.');
}

async function openBrowser(url: string) {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      await execFileAsync('open', [url]);
    } else if (platform === 'linux') {
      await execFileAsync('xdg-open', [url]);
    } else if (platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', url]);
    }
  } catch {
    // Best effort — don't crash the server if browser open fails
    console.warn(`[autome] Could not open browser at ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    return;
  }

  if (args.version) {
    showVersion();
    return;
  }

  switch (args.command) {
    case 'start':
      await cmdStart(args);
      break;
    case 'doctor':
      await cmdDoctor(args);
      break;
    default:
      console.error(`[autome] Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[autome] Fatal error:', err);
  process.exit(1);
});
