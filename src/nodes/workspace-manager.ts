/**
 * Workspace Manager — manages versioned workspaces for Code Executor nodes.
 *
 * Layout: data/workspaces/code/{workflowId}/v{version}/
 *   ├── package.json
 *   ├── node_modules/
 *   └── runs/   (temp code files per execution)
 */
import { mkdir, writeFile, readFile, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BASE_DIR = join(process.cwd(), 'data', 'workspaces', 'code');

export interface WorkspaceInfo {
  /** Root of the versioned workspace */
  root: string;
  /** Path to node_modules */
  nodeModules: string;
  /** Path to runs/ directory for temp files */
  runsDir: string;
}

/**
 * Ensure the workspace exists and dependencies are installed.
 * Skips npm install if package.json hasn't changed.
 */
export async function ensureWorkspace(
  workflowId: string,
  version: number,
  dependencies: Record<string, string>,
): Promise<WorkspaceInfo> {
  const root = join(BASE_DIR, workflowId, `v${version}`);
  const runsDir = join(root, 'runs');
  const nodeModules = join(root, 'node_modules');
  const pkgPath = join(root, 'package.json');

  await mkdir(runsDir, { recursive: true });

  // Build the desired package.json
  const desiredPkg = JSON.stringify(
    {
      name: `code-executor-${workflowId}`,
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies,
    },
    null,
    2,
  );

  // Check if package.json already matches — skip install if so
  let needsInstall = true;
  if (existsSync(pkgPath)) {
    try {
      const existing = await readFile(pkgPath, 'utf-8');
      if (existing === desiredPkg && existsSync(nodeModules)) {
        needsInstall = false;
      }
    } catch {
      // corrupt file, re-install
    }
  }

  if (needsInstall && Object.keys(dependencies).length > 0) {
    await writeFile(pkgPath, desiredPkg, 'utf-8');
    console.log(`[workspace] Installing deps for ${workflowId}/v${version}:`, Object.keys(dependencies).join(', '));
    try {
      await execFileAsync('npm', ['install', '--production', '--no-audit', '--no-fund'], {
        cwd: root,
        timeout: 120_000,
        env: { ...process.env, NODE_ENV: 'production' },
      });
      console.log(`[workspace] Deps installed for ${workflowId}/v${version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to install dependencies: ${msg}`);
    }
  } else if (Object.keys(dependencies).length === 0) {
    // No deps — just ensure package.json exists for module resolution
    if (!existsSync(pkgPath)) {
      await writeFile(pkgPath, desiredPkg, 'utf-8');
    }
  }

  return { root, nodeModules, runsDir };
}

/**
 * Write the user's code module and a runner wrapper.
 * Returns the path to the runner file (the entry point).
 *
 * Layout:
 *   runs/{fileId}_code.mjs   — user's code (verbatim, normal ES module)
 *   runs/{fileId}_run.mjs    — wrapper that imports code and calls default export
 */
export async function writeCodeFile(
  runsDir: string,
  fileId: string,
  userCode: string,
  inputData: Record<string, unknown>,
): Promise<string> {
  const codePath = join(runsDir, `${fileId}_code.mjs`);
  const runPath = join(runsDir, `${fileId}_run.mjs`);

  // Write user code verbatim as a module
  await writeFile(codePath, userCode, 'utf-8');

  // Write runner that imports and calls the default export
  const runner = `
import handler from './${fileId}_code.mjs';

const __input = ${JSON.stringify(inputData)};

try {
  if (typeof handler !== 'function') {
    throw new Error('Code must have a default export that is a function. Got: ' + typeof handler);
  }
  const __result = await Promise.resolve(handler(__input));
  process.stdout.write('\\n__CODE_EXEC_OUTPUT_START__\\n' + JSON.stringify(__result) + '\\n__CODE_EXEC_OUTPUT_END__\\n');
} catch (err) {
  process.stderr.write(err?.stack || err?.message || String(err));
  process.exit(1);
}
`;

  await writeFile(runPath, runner, 'utf-8');
  return runPath;
}

/**
 * Clean up temporary code files after execution.
 */
export async function cleanupCodeFile(runnerPath: string): Promise<void> {
  try {
    // Runner is {id}_run.mjs, code is {id}_code.mjs
    const codePath = runnerPath.replace(/_run\.mjs$/, '_code.mjs');
    await unlink(runnerPath);
    await unlink(codePath);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Clean up old version workspaces that are no longer needed.
 * Call periodically or when versions are known to be obsolete.
 */
export async function cleanupOldVersions(
  workflowId: string,
  keepVersions: number[],
): Promise<void> {
  const workflowDir = join(BASE_DIR, workflowId);
  if (!existsSync(workflowDir)) return;

  const { readdir } = await import('fs/promises');
  const entries = await readdir(workflowDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('v')) continue;
    const ver = parseInt(entry.name.slice(1), 10);
    if (!isNaN(ver) && !keepVersions.includes(ver)) {
      console.log(`[workspace] Cleaning up ${workflowId}/${entry.name}`);
      await rm(join(workflowDir, entry.name), { recursive: true, force: true });
    }
  }
}
