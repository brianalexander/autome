import { describe, it, expect } from 'vitest';
import { shellExecutorNodeSpec, interpolateCommand } from '../shell-executor.js';
import type { StepExecutorContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Minimal mock for Restate ctx — ctx.run just invokes the callback directly
// ---------------------------------------------------------------------------

function makeMockCtx() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

function makeExecCtx(overrides: Partial<StepExecutorContext> = {}): StepExecutorContext {
  return {
    ctx: makeMockCtx() as unknown as StepExecutorContext['ctx'],
    stageId: 'test-stage',
    config: { command: 'echo hello', timeout_seconds: 10, shell: '/bin/bash', parse_json: true },
    definition: { id: 'wf-1', version: 1, name: 'Test', active: false, trigger: { provider: 'manual' }, stages: [], edges: [] },
    workflowContext: {
      trigger: {},
      stages: {},
    } as unknown as StepExecutorContext['workflowContext'],
    input: { sourceOutput: {} },
    orchestratorUrl: 'http://localhost:3000',
    iteration: 0,
    ...overrides,
  };
}

const executor = shellExecutorNodeSpec.executor as { execute: (ctx: StepExecutorContext) => Promise<{ output: unknown }> };

// ---------------------------------------------------------------------------
// interpolateCommand unit tests
// ---------------------------------------------------------------------------

describe('interpolateCommand', () => {
  it('replaces simple input expressions', () => {
    const result = interpolateCommand('echo ${input.name}', { input: { name: 'world' } });
    expect(result).toBe('echo world');
  });

  it('replaces nested path expressions', () => {
    const result = interpolateCommand('echo ${context.stages.s1.latest.value}', {
      context: { stages: { s1: { latest: { value: '42' } } } },
    });
    expect(result).toBe('echo 42');
  });

  it('leaves unresolvable expressions intact', () => {
    const result = interpolateCommand('echo ${missing.field}', {});
    expect(result).toBe('echo ${missing.field}');
  });

  it('handles multiple expressions in one command', () => {
    const result = interpolateCommand('echo ${input.a} ${input.b}', {
      input: { a: 'foo', b: 'bar' },
    });
    expect(result).toBe('echo foo bar');
  });

  it('converts non-string values to strings', () => {
    const result = interpolateCommand('echo ${input.count}', { input: { count: 99 } });
    expect(result).toBe('echo 99');
  });
});

// ---------------------------------------------------------------------------
// Shell executor integration tests (real child process)
// ---------------------------------------------------------------------------

describe('shell-executor execute()', () => {
  it('executes a basic echo command', async () => {
    const ctx = makeExecCtx({ config: { command: 'echo hello', parse_json: false } });
    const { output } = await executor.execute(ctx);
    expect(output).toMatchObject({ stdout: 'hello', exitCode: 0 });
  });

  it('parses JSON stdout when parse_json is true', async () => {
    const ctx = makeExecCtx({
      config: { command: "echo '{\"key\": \"value\"}'", parse_json: true },
    });
    const { output } = await executor.execute(ctx);
    // JSON object is spread with stderr/exitCode appended
    expect(output).toMatchObject({ key: 'value', exitCode: 0 });
  });

  it('returns raw output when parse_json is false', async () => {
    const ctx = makeExecCtx({
      config: { command: "echo '{\"key\": \"value\"}'", parse_json: false },
    });
    const { output } = await executor.execute(ctx);
    expect(output).toMatchObject({ stdout: '{"key": "value"}', exitCode: 0 });
  });

  it('wraps JSON array output in a result envelope', async () => {
    const ctx = makeExecCtx({
      config: { command: 'echo \'[1,2,3]\'', parse_json: true },
    });
    const { output } = await executor.execute(ctx);
    expect(output).toMatchObject({ result: [1, 2, 3], exitCode: 0 });
  });

  it('throws on non-zero exit code', async () => {
    const ctx = makeExecCtx({
      config: { command: 'exit 1', parse_json: false },
    });
    await expect(executor.execute(ctx)).rejects.toThrow('exited with code 1');
  });

  it('throws on non-zero exit code with stderr message', async () => {
    const ctx = makeExecCtx({
      config: { command: 'echo "oops" >&2; exit 2', parse_json: false },
    });
    await expect(executor.execute(ctx)).rejects.toThrow('exited with code 2');
  });

  it('interpolates template variables in the command', async () => {
    const ctx = makeExecCtx({
      config: { command: 'echo ${input.greeting}', parse_json: false },
      input: { sourceOutput: { greeting: 'hi there' } },
    });
    const { output } = await executor.execute(ctx);
    expect(output).toMatchObject({ stdout: 'hi there', exitCode: 0 });
  });

  it('captures stderr alongside stdout', async () => {
    const ctx = makeExecCtx({
      config: { command: 'echo "err" >&2; echo "out"', parse_json: false },
    });
    const { output } = await executor.execute(ctx);
    const o = output as Record<string, unknown>;
    expect(o.stdout).toBe('out');
    expect(String(o.stderr).trim()).toBe('err');
    expect(o.exitCode).toBe(0);
  });

  it('throws a timeout error when command exceeds timeout', async () => {
    const ctx = makeExecCtx({
      config: { command: 'sleep 10', timeout_seconds: 1, parse_json: false },
    });
    // The timeout error may surface as either a killed/timeout message or exit code
    await expect(executor.execute(ctx)).rejects.toThrow();
  }, 5000);

  it('throws when command is empty', async () => {
    const ctx = makeExecCtx({ config: { command: '' } });
    await expect(executor.execute(ctx)).rejects.toThrow('command is empty');
  });
});

// ---------------------------------------------------------------------------
// Node spec metadata
// ---------------------------------------------------------------------------

describe('shellExecutorNodeSpec metadata', () => {
  it('has correct id and category', () => {
    expect(shellExecutorNodeSpec.id).toBe('shell-executor');
    expect(shellExecutorNodeSpec.category).toBe('step');
  });

  it('requires command in configSchema', () => {
    expect(shellExecutorNodeSpec.configSchema.required).toContain('command');
  });

  it('has expected defaultConfig', () => {
    expect(shellExecutorNodeSpec.defaultConfig).toMatchObject({
      timeout_seconds: 30,
      shell: '/bin/bash',
      parse_json: true,
    });
  });

  it('has outEdgeSchema with condition', () => {
    expect(shellExecutorNodeSpec.outEdgeSchema).toBeDefined();
    const schema = shellExecutorNodeSpec.outEdgeSchema as Record<string, unknown>;
    expect((schema.properties as Record<string, unknown>)?.condition).toBeDefined();
  });
});
