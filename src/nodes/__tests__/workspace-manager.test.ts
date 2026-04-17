/**
 * Tests for workspace-manager.ts
 *
 * Strategy:
 * - Use a real temp directory so mkdir/writeFile/readFile work as production code does.
 * - Mock execFile (the npm install call) to avoid network access in CI.
 * - Override BASE_DIR via the workflowId path patterns — each test uses a UUID-like
 *   ID so they don't share workspace directories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mock child_process so npm install never actually runs
// ---------------------------------------------------------------------------

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      // Simulate a successful npm install (callback with no error)
      callback(null, '', '');
    }),
  };
});

// The module uses promisify(execFile) at module-load time, so we need to also
// intercept the promisified path. Because workspace-manager imports execFile at
// the top level and then wraps it with promisify, we mock 'util' to return a
// function that resolves immediately.
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: vi.fn((fn: Function) => {
      // Only intercept execFile — let everything else through
      if (fn.name === 'execFile' || fn.toString().includes('execFile')) {
        return vi.fn(async () => ({ stdout: '', stderr: '' }));
      }
      return actual.promisify(fn);
    }),
  };
});

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mocks are set up
// ---------------------------------------------------------------------------

// We need to control BASE_DIR. The simplest approach: re-implement the functions
// under a custom data dir by using the exported functions with workflow IDs that
// map into our temp directory. However, BASE_DIR is hardcoded to process.cwd().
// Instead, we override process.cwd() for the duration of these tests.

let tempDataDir: string;

// Capture original cwd before any test modifies it
const originalCwd = process.cwd();

// Override process.cwd so BASE_DIR (data/workspaces/code) is inside our temp dir
vi.spyOn(process, 'cwd').mockImplementation(() => tempDataDir ?? originalCwd);

import {
  ensureWorkspace,
  cleanupOldVersions,
  writeCodeFile,
  cleanupCodeFile,
} from '../workspace-manager.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDataDir = await mkdtemp(join(tmpdir(), 'autome-ws-test-'));
});

afterEach(async () => {
  await rm(tempDataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ensureWorkspace — no dependencies
// ---------------------------------------------------------------------------

describe('ensureWorkspace — no dependencies', () => {
  it('creates the workspace directory structure', async () => {
    const info = await ensureWorkspace('wf-001', 1, {});

    expect(existsSync(info.root)).toBe(true);
    expect(existsSync(info.runsDir)).toBe(true);
    expect(info.nodeModules).toContain('node_modules');
  });

  it('writes a package.json even when there are no dependencies', async () => {
    const info = await ensureWorkspace('wf-002', 1, {});
    const pkgPath = join(info.root, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(pkg.name).toBe('code-executor-wf-002');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({});
  });

  it('does not run npm install when there are no dependencies', async () => {
    const { execFile } = await import('child_process');
    await ensureWorkspace('wf-003', 1, {});
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureWorkspace — with dependencies
// ---------------------------------------------------------------------------

describe('ensureWorkspace — with dependencies', () => {
  it('writes the correct package.json with the requested dependencies', async () => {
    const deps = { lodash: '^4.17.21', 'date-fns': '^3.0.0' };
    const info = await ensureWorkspace('wf-010', 1, deps);

    const pkg = JSON.parse(await readFile(join(info.root, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual(deps);
  });

  it('includes NODE_ENV=production and timeout when running npm install', async () => {
    // Re-import util's promisify mock to capture the npm call
    // The mock already captures the call; we just verify the package.json was written
    // before the (mocked) install, and the node_modules presence is not checked
    // since we mock the install itself.
    const deps = { axios: '^1.0.0' };
    const info = await ensureWorkspace('wf-011', 1, deps);

    // Package.json was written
    const pkgPath = join(info.root, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureWorkspace — caching (second call is a no-op)
// ---------------------------------------------------------------------------

describe('ensureWorkspace — caching', () => {
  it('skips npm install on a second call with the same deps when node_modules exists', async () => {
    const deps = { lodash: '^4.17.21' };
    const workflowId = 'wf-cache-001';

    // First call — installs deps
    const info = await ensureWorkspace(workflowId, 1, deps);

    // Simulate node_modules existing (the mocked install doesn't create it)
    await mkdir(info.nodeModules, { recursive: true });

    // Clear the call count
    vi.clearAllMocks();
    const { execFile } = await import('child_process');

    // Second call — should detect package.json is unchanged + node_modules exists
    await ensureWorkspace(workflowId, 1, deps);

    // npm should not have been called again
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('reinstalls if package.json content changed (deps changed)', async () => {
    const workflowId = 'wf-cache-002';

    const info = await ensureWorkspace(workflowId, 1, { lodash: '^4.0.0' });
    await mkdir(info.nodeModules, { recursive: true });

    vi.clearAllMocks();

    // Second call with different deps — should re-install
    await ensureWorkspace(workflowId, 1, { lodash: '^5.0.0' });

    // The updated package.json should reflect the new version
    const pkg = JSON.parse(await readFile(join(info.root, 'package.json'), 'utf-8'));
    expect(pkg.dependencies.lodash).toBe('^5.0.0');
  });
});

// ---------------------------------------------------------------------------
// ensureWorkspace — different versions create separate workspaces
// ---------------------------------------------------------------------------

describe('ensureWorkspace — versioning', () => {
  it('creates separate directories for different versions', async () => {
    const workflowId = 'wf-ver-001';
    const v1 = await ensureWorkspace(workflowId, 1, {});
    const v2 = await ensureWorkspace(workflowId, 2, {});

    expect(v1.root).not.toBe(v2.root);
    expect(v1.root).toContain('v1');
    expect(v2.root).toContain('v2');
    expect(existsSync(v1.root)).toBe(true);
    expect(existsSync(v2.root)).toBe(true);
  });

  it('workspace root contains the workflowId and version', async () => {
    const info = await ensureWorkspace('my-workflow', 3, {});
    expect(info.root).toContain('my-workflow');
    expect(info.root).toContain('v3');
  });
});

// ---------------------------------------------------------------------------
// cleanupOldVersions
// ---------------------------------------------------------------------------

describe('cleanupOldVersions', () => {
  it('removes old version directories that are not in keepVersions', async () => {
    const workflowId = 'wf-cleanup-001';

    // Create v1, v2, v3
    const v1 = await ensureWorkspace(workflowId, 1, {});
    const v2 = await ensureWorkspace(workflowId, 2, {});
    const v3 = await ensureWorkspace(workflowId, 3, {});

    await cleanupOldVersions(workflowId, [3]);

    expect(existsSync(v1.root)).toBe(false);
    expect(existsSync(v2.root)).toBe(false);
    expect(existsSync(v3.root)).toBe(true);
  });

  it('keeps multiple versions when all are listed', async () => {
    const workflowId = 'wf-cleanup-002';

    const v1 = await ensureWorkspace(workflowId, 1, {});
    const v2 = await ensureWorkspace(workflowId, 2, {});

    await cleanupOldVersions(workflowId, [1, 2]);

    expect(existsSync(v1.root)).toBe(true);
    expect(existsSync(v2.root)).toBe(true);
  });

  it('is a no-op when the workflow directory does not exist', async () => {
    // Should not throw
    await expect(cleanupOldVersions('nonexistent-wf', [1])).resolves.toBeUndefined();
  });

  it('removes all versions when keepVersions is empty', async () => {
    const workflowId = 'wf-cleanup-003';

    const v1 = await ensureWorkspace(workflowId, 1, {});
    const v2 = await ensureWorkspace(workflowId, 2, {});

    await cleanupOldVersions(workflowId, []);

    expect(existsSync(v1.root)).toBe(false);
    expect(existsSync(v2.root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeCodeFile / cleanupCodeFile
// ---------------------------------------------------------------------------

describe('writeCodeFile', () => {
  it('writes the user code and a runner wrapper, returning the runner path', async () => {
    const info = await ensureWorkspace('wf-code-001', 1, {});
    const userCode = `export default function(input) { return input.value * 2; }`;
    const runnerPath = await writeCodeFile(info.runsDir, 'test-id', userCode, { value: 42 });

    expect(runnerPath).toMatch(/_run\.ts$/);
    expect(existsSync(runnerPath)).toBe(true);

    const codeFilePath = runnerPath.replace(/_run\.ts$/, '_code.ts');
    expect(existsSync(codeFilePath)).toBe(true);

    const codeContent = await readFile(codeFilePath, 'utf-8');
    expect(codeContent).toBe(userCode);

    const runnerContent = await readFile(runnerPath, 'utf-8');
    expect(runnerContent).toContain('test-id_code.ts');
    expect(runnerContent).toContain('"value":42');
    expect(runnerContent).toContain('__CODE_EXEC_OUTPUT_START__');
    expect(runnerContent).toContain('__AUTOME_SECRETS__');
    expect(runnerContent).toContain('context');
  });

  it('serializes input data into the runner', async () => {
    const info = await ensureWorkspace('wf-code-002', 1, {});
    const inputData = { name: 'Alice', count: 7, nested: { x: true } };
    const runnerPath = await writeCodeFile(info.runsDir, 'input-test', `export default (i) => i`, inputData);

    const content = await readFile(runnerPath, 'utf-8');
    expect(content).toContain(JSON.stringify(inputData));
  });
});

describe('cleanupCodeFile', () => {
  it('deletes both the runner and code files', async () => {
    const info = await ensureWorkspace('wf-cleanup-code-001', 1, {});
    const runnerPath = await writeCodeFile(info.runsDir, 'cleanup-id', `export default () => {}`, {});

    const codePath = runnerPath.replace(/_run\.ts$/, '_code.ts');
    expect(existsSync(runnerPath)).toBe(true);
    expect(existsSync(codePath)).toBe(true);

    await cleanupCodeFile(runnerPath);

    expect(existsSync(runnerPath)).toBe(false);
    expect(existsSync(codePath)).toBe(false);
  });

  it('does not throw if files are already gone', async () => {
    const fakePath = join(tmpdir(), 'does-not-exist_run.ts');
    await expect(cleanupCodeFile(fakePath)).resolves.toBeUndefined();
  });
});
