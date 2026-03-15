/**
 * Tests for the code-trigger built-in node.
 *
 * These tests mock workspace-manager to avoid real npm installs and file I/O,
 * and test the trigger lifecycle: spawning, event parsing, cleanup, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Mock workspace-manager before importing the module under test.
// NOTE: vi.mock factories are hoisted — no top-level variable references allowed.
// ---------------------------------------------------------------------------

vi.mock('../../../nodes/workspace-manager.js', () => ({
  ensureWorkspace: vi.fn().mockResolvedValue({
    root: '/tmp/test-workspace',
    nodeModules: '/tmp/test-workspace/node_modules',
    runsDir: '/tmp/test-workspace/runs',
  }),
}));

// Keep constants for assertions — must mirror the values above.
const mockWorkspaceRoot = '/tmp/test-workspace';
const mockRunsDir = '/tmp/test-workspace/runs';

// ---------------------------------------------------------------------------
// Mock fs/promises — capture written files, no-op cleanup
// ---------------------------------------------------------------------------

const writtenFiles: Map<string, string> = new Map();

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (path: string, content: string) => {
    writtenFiles.set(path, content);
  }),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock child_process.spawn — return a controllable fake child process
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn((signal?: string) => {
    this.killed = true;
    // Simulate async exit after kill
    setImmediate(() => this.emit('exit', signal === 'SIGTERM' ? null : 1, signal ?? null));
  });
}

let fakeChild: FakeChildProcess;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    fakeChild = new FakeChildProcess();
    return fakeChild as unknown as ChildProcess;
  }),
}));

// ---------------------------------------------------------------------------
// Import the module AFTER mocks are in place
// ---------------------------------------------------------------------------

import { codeTriggerSpec } from '../code-trigger.js';
import { ensureWorkspace } from '../../../nodes/workspace-manager.js';
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import type { TriggerExecutor } from '../../types.js';

const executor = codeTriggerSpec.executor as TriggerExecutor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    code: 'export default ({ emit, signal }) => { emit({ hello: "world" }); }',
    dependencies: {},
    timeout_seconds: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codeTriggerSpec metadata', () => {
  it('has correct id and category', () => {
    expect(codeTriggerSpec.id).toBe('code-trigger');
    expect(codeTriggerSpec.category).toBe('trigger');
  });

  it('has triggerMode: immediate', () => {
    expect(codeTriggerSpec.triggerMode).toBe('immediate');
  });

  it('has purple color theme', () => {
    expect(codeTriggerSpec.color.border).toBe('#a855f7');
    expect(codeTriggerSpec.color.text).toBe('#9333ea');
  });

  it('requires code in configSchema', () => {
    expect(codeTriggerSpec.configSchema.required).toContain('code');
  });

  it('has timeout_seconds default of 0 in defaultConfig', () => {
    expect(codeTriggerSpec.defaultConfig.timeout_seconds).toBe(0);
  });
});

describe('activate() — spawn and cleanup lifecycle', () => {
  beforeEach(() => {
    writtenFiles.clear();
    vi.clearAllMocks();
  });

  it('calls ensureWorkspace with the workflow id and dependencies', async () => {
    const cleanup = await executor.activate!('wf-1', 'stage-1', makeConfig({ dependencies: { lodash: '^4.0.0' } }), vi.fn());
    cleanup();

    expect(ensureWorkspace).toHaveBeenCalledWith('wf-1', 1, { lodash: '^4.0.0' });
  });

  it('writes a user code file and wrapper file to the runs dir', async () => {
    const code = 'export default ({ emit }) => emit({ x: 1 });';
    const cleanup = await executor.activate!('wf-2', 'stage-2', makeConfig({ code }), vi.fn());
    cleanup();

    const paths = [...writtenFiles.keys()];
    const codePaths = paths.filter((p) => p.includes(mockRunsDir) && p.endsWith('_code.mjs'));
    const wrapperPaths = paths.filter((p) => p.includes(mockRunsDir) && p.endsWith('_wrapper.mjs'));

    expect(codePaths).toHaveLength(1);
    expect(wrapperPaths).toHaveLength(1);

    // Verify user code is written verbatim
    expect(writtenFiles.get(codePaths[0])).toBe(code);
  });

  it('wrapper script imports from the user code file', async () => {
    const cleanup = await executor.activate!('wf-3', 'stage-3', makeConfig(), vi.fn());
    cleanup();

    const wrapperPath = [...writtenFiles.keys()].find((p) => p.endsWith('_wrapper.mjs'))!;
    const wrapperContent = writtenFiles.get(wrapperPath)!;

    expect(wrapperContent).toContain("import userFn from './");
    expect(wrapperContent).toContain('_code.mjs');
    expect(wrapperContent).toContain('__TRIGGER_EVENT__:');
    expect(wrapperContent).toContain('ac.abort()');
  });

  it('spawns a child process with the wrapper script', async () => {
    const cleanup = await executor.activate!('wf-4', 'stage-4', makeConfig(), vi.fn());
    cleanup();

    expect(spawn).toHaveBeenCalledOnce();
    const [bin, args, opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toContain('_wrapper.mjs');
    expect(opts.cwd).toBe(mockWorkspaceRoot);
    expect(opts.env).toMatchObject({ TRIGGER_CONFIG: expect.any(String) });
  });

  it('TRIGGER_CONFIG env var contains serialized config', async () => {
    const config = makeConfig({ pollIntervalMs: 5000 });
    const cleanup = await executor.activate!('wf-5', 'stage-5', config, vi.fn());
    cleanup();

    const [, , opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsedConfig = JSON.parse(opts.env.TRIGGER_CONFIG);
    expect(parsedConfig.pollIntervalMs).toBe(5000);
  });

  it('cleanup function kills the child process with SIGTERM', async () => {
    const cleanup = await executor.activate!('wf-6', 'stage-6', makeConfig(), vi.fn());
    cleanup();

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleanup function deletes temp files', async () => {
    const cleanup = await executor.activate!('wf-7', 'stage-7', makeConfig(), vi.fn());
    cleanup();

    // Give microtasks a tick to run
    await Promise.resolve();

    const unlinkMock = unlink as ReturnType<typeof vi.fn>;
    expect(unlinkMock).toHaveBeenCalledTimes(2);
    const deletedPaths = unlinkMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(deletedPaths.some((p) => p.endsWith('_code.mjs'))).toBe(true);
    expect(deletedPaths.some((p) => p.endsWith('_wrapper.mjs'))).toBe(true);
  });
});

describe('activate() — event parsing from stdout', () => {
  beforeEach(() => {
    writtenFiles.clear();
    vi.clearAllMocks();
  });

  it('calls emit callback when a __TRIGGER_EVENT__ line arrives on stdout', async () => {
    const emitCallback = vi.fn();
    const cleanup = await executor.activate!('wf-emit-1', 'stage-1', makeConfig(), emitCallback);

    const event = { payload: { status: 'ready' }, timestamp: '2026-01-01T00:00:00.000Z' };
    fakeChild.stdout.emit('data', Buffer.from(`__TRIGGER_EVENT__:${JSON.stringify(event)}\n`));

    cleanup();

    expect(emitCallback).toHaveBeenCalledOnce();
    expect(emitCallback).toHaveBeenCalledWith(event);
  });

  it('calls emit for each event in a multi-line stdout chunk', async () => {
    const emitCallback = vi.fn();
    const cleanup = await executor.activate!('wf-emit-2', 'stage-2', makeConfig(), emitCallback);

    const e1 = { seq: 1 };
    const e2 = { seq: 2 };
    const chunk = `__TRIGGER_EVENT__:${JSON.stringify(e1)}\n__TRIGGER_EVENT__:${JSON.stringify(e2)}\n`;
    fakeChild.stdout.emit('data', Buffer.from(chunk));

    cleanup();

    expect(emitCallback).toHaveBeenCalledTimes(2);
    expect(emitCallback).toHaveBeenNthCalledWith(1, e1);
    expect(emitCallback).toHaveBeenNthCalledWith(2, e2);
  });

  it('handles partial lines split across multiple data chunks', async () => {
    const emitCallback = vi.fn();
    const cleanup = await executor.activate!('wf-emit-3', 'stage-3', makeConfig(), emitCallback);

    const event = { partial: true };
    const fullLine = `__TRIGGER_EVENT__:${JSON.stringify(event)}\n`;
    // Split the line in two
    fakeChild.stdout.emit('data', Buffer.from(fullLine.slice(0, 20)));
    fakeChild.stdout.emit('data', Buffer.from(fullLine.slice(20)));

    cleanup();

    expect(emitCallback).toHaveBeenCalledOnce();
    expect(emitCallback).toHaveBeenCalledWith(event);
  });

  it('ignores non-sentinel stdout lines (e.g. console.log from user code)', async () => {
    const emitCallback = vi.fn();
    const cleanup = await executor.activate!('wf-emit-4', 'stage-4', makeConfig(), emitCallback);

    fakeChild.stdout.emit('data', Buffer.from('just a log message\n'));
    fakeChild.stdout.emit('data', Buffer.from('another log\n'));

    cleanup();

    expect(emitCallback).not.toHaveBeenCalled();
  });

  it('does not crash on malformed JSON in a sentinel line', async () => {
    const emitCallback = vi.fn();
    const cleanup = await executor.activate!('wf-emit-5', 'stage-5', makeConfig(), emitCallback);

    fakeChild.stdout.emit('data', Buffer.from('__TRIGGER_EVENT__:{not valid json}\n'));

    cleanup();

    // Should not throw, and emit should not be called
    expect(emitCallback).not.toHaveBeenCalled();
  });
});

describe('activate() — timeout', () => {
  beforeEach(() => {
    writtenFiles.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills the process after timeout_seconds if set', async () => {
    const cleanup = await executor.activate!('wf-timeout-1', 'stage-1', makeConfig({ timeout_seconds: 10 }), vi.fn());

    // Process should not be killed yet
    expect(fakeChild.kill).not.toHaveBeenCalled();

    // Advance past timeout
    vi.advanceTimersByTime(11_000);

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

    cleanup();
  });

  it('does not set a timeout when timeout_seconds is 0', async () => {
    const cleanup = await executor.activate!('wf-timeout-2', 'stage-2', makeConfig({ timeout_seconds: 0 }), vi.fn());

    vi.advanceTimersByTime(1_000_000);

    // kill should not have been called by the timeout (only by cleanup below)
    expect(fakeChild.kill).not.toHaveBeenCalled();

    cleanup();
  });
});
