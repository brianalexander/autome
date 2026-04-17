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

// ---------------------------------------------------------------------------
// Doctor rendering helpers
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Icon characters keyed by pass/warn/fail state */
const ICON_OK = '\u2713'; // ✓
const ICON_WARN = '\u26a0'; // ⚠
const ICON_ERR = '\u2717'; // ✗

/** 7-space indent so sub-items align under plugin name text */
const SUB_INDENT = '       ';

function sectionHeader(title: string): void {
  console.log(`\n  ${BOLD}${title}${RESET}`);
}

function checkLine(icon: string, label: string, detail?: string): void {
  const suffix = detail ? `  (${detail})` : '';
  console.log(`  ${icon}  ${label}${suffix}`);
}

function subLine(icon: string, label: string): void {
  console.log(`${SUB_INDENT}${icon}  ${label}`);
}

// ---------------------------------------------------------------------------
// Doctor command
// ---------------------------------------------------------------------------

async function cmdDoctor(_args: ParsedArgs) {
  let totalErrors = 0;
  let totalWarnings = 0;

  // ---- Environment section ------------------------------------------------
  sectionHeader('Environment');

  // 1. Node version >= 20
  const [major] = process.versions.node.split('.').map(Number);
  const nodeOk = major >= 20;
  if (!nodeOk) totalErrors++;
  checkLine(nodeOk ? ICON_OK : ICON_ERR, `Node.js >= 20 (found ${process.versions.node})`);

  // 2. Load config
  let resolvedConfig;
  try {
    resolvedConfig = await loadConfig();
    checkLine(ICON_OK, 'Config loads without error');
  } catch (err) {
    totalErrors++;
    checkLine(ICON_ERR, 'Config loads without error', String(err));
    // Can't continue without config
    printDoctorSummary(totalErrors, totalWarnings);
    if (totalErrors > 0) process.exit(1);
    return;
  }

  // 3. DB directory writable
  try {
    const dbDir = dirname(resolvedConfig.databasePath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const { accessSync, constants } = await import('node:fs');
    accessSync(dbDir, constants.W_OK);
    checkLine(ICON_OK, `DB dir writable (${dbDir})`);
  } catch (err) {
    totalErrors++;
    checkLine(ICON_ERR, `DB dir writable (${resolvedConfig.databasePath})`, String(err));
  }

  // ---- Plugins section ----------------------------------------------------
  const { loadPlugins } = await import('../plugin/loader.js');
  const { validatePlugins } = await import('../plugin/validate.js');
  const { allBuiltinSpecs } = await import('../nodes/builtin/index.js');

  let pluginLoadResult: Awaited<ReturnType<typeof loadPlugins>> | null = null;
  let pluginLoadError: unknown = null;

  try {
    pluginLoadResult = await loadPlugins();
  } catch (err) {
    pluginLoadError = err;
  }

  if (pluginLoadError !== null || pluginLoadResult === null) {
    sectionHeader('Plugins');
    totalErrors++;
    checkLine(ICON_ERR, `Failed to load plugins: ${String(pluginLoadError)}`);
  } else {
    const { loaded, failures } = pluginLoadResult;

    const pluginCount = loaded.length + failures.length;
    sectionHeader(`Plugins (${pluginCount} loaded)`);

    // Show load failures first
    for (const failure of failures) {
      totalErrors++;
      checkLine(ICON_ERR, `Failed to load ${failure.path}: ${failure.error.message}`);
    }

    if (loaded.length === 0 && failures.length === 0) {
      checkLine(ICON_OK, 'No plugins loaded');
    } else if (loaded.length > 0) {
      const builtinIds = new Set(allBuiltinSpecs.map((s) => s.id));
      const report = await validatePlugins(loaded, builtinIds);

      for (const result of report.plugins) {
        const { plugin, issues, nodeTypeIds, templateIds } = result;
        const hasError = issues.some((i) => i.severity === 'error');
        const hasWarning = issues.some((i) => i.severity === 'warning');
        const pluginIcon = hasError ? ICON_ERR : hasWarning ? ICON_WARN : ICON_OK;
        const versionLabel = plugin.manifest.version ? ` v${plugin.manifest.version}` : '';
        checkLine(pluginIcon, `${plugin.manifest.name}${versionLabel}`);

        // Node types summary
        if (nodeTypeIds.length > 0) {
          subLine(ICON_OK, `Node types (${nodeTypeIds.length}): ${nodeTypeIds.join(', ')}`);
        }

        // Template summary
        if (templateIds.length > 0) {
          subLine(ICON_OK, `Templates (${templateIds.length}): ${templateIds.join(', ')}`);
        }

        // Individual issues
        for (const issue of issues) {
          if (issue.severity === 'error') {
            totalErrors++;
            subLine(ICON_ERR, issue.message);
          } else if (issue.severity === 'warning') {
            totalWarnings++;
            subLine(ICON_WARN, issue.message);
          }
        }
      }

      // Cross-plugin issues (shown after all plugin results)
      for (const issue of report.crossIssues) {
        if (issue.severity === 'error') {
          totalErrors++;
          checkLine(ICON_ERR, issue.message);
        } else if (issue.severity === 'warning') {
          totalWarnings++;
          checkLine(ICON_WARN, issue.message);
        }
      }
    }
  }

  // ---- Secrets section -------------------------------------------------------
  sectionHeader('Secrets');

  try {
    const { resolveMasterKey } = await import('../secrets/master-key.js');
    const { source } = resolveMasterKey(resolvedConfig.dataDir);
    if (source === 'env') {
      checkLine(ICON_OK, 'Master key loaded from AUTOME_MASTER_KEY env var');
    } else if (source === 'file') {
      totalWarnings++;
      checkLine(ICON_WARN, 'Master key stored in .master-key file — set AUTOME_MASTER_KEY env var for production');
    } else {
      totalWarnings++;
      checkLine(ICON_WARN, 'Master key generated and stored in .master-key file — set AUTOME_MASTER_KEY env var for production');
    }
  } catch (err) {
    totalErrors++;
    checkLine(ICON_ERR, `Master key resolution failed: ${String(err)}`);
  }

  // ---- ACP Providers section -----------------------------------------------
  sectionHeader('ACP Providers');

  if (resolvedConfig.acpProvider) {
    const cliMap: Record<string, string> = {
      kiro: 'kiro-cli',
      opencode: 'opencode',
      'claude-code': 'claude',
    };
    const cliName = cliMap[resolvedConfig.acpProvider] ?? resolvedConfig.acpProvider;
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const result = await execAsync(`${whichCmd} ${cliName}`);
      const foundPath = result.stdout.trim();
      checkLine(ICON_OK, `${resolvedConfig.acpProvider} (found at ${foundPath})`);
    } catch {
      totalErrors++;
      checkLine(ICON_ERR, `${resolvedConfig.acpProvider} — '${cliName}' not found in PATH`);
    }
  } else {
    checkLine(ICON_OK, 'none configured (will use default)');
  }

  // ---- Summary -------------------------------------------------------------
  console.log('');
  printDoctorSummary(totalErrors, totalWarnings);
  if (totalErrors > 0) process.exit(1);
}

function printDoctorSummary(errors: number, warnings: number): void {
  if (errors === 0 && warnings === 0) {
    console.log('All checks passed.');
  } else {
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
    if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
    console.log(`Some checks failed. ${parts.join(', ')}.`);
  }
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
