import { describe, it, expect, vi } from 'vitest';
import { gateNodeSpec } from '../gate.js';
import { TerminalError } from '../../../engine/types.js';
import type { StepExecutor, StepExecutorContext } from '../../types.js';

/**
 * Build a minimal StepExecutorContext for gate executor tests.
 */
function buildCtx(
  stageId: string,
  config: Record<string, unknown>,
  waitForValue?: unknown,
  upstreamInput?: unknown,
  workflowContext?: unknown,
): StepExecutorContext {
  return {
    ctx: {
      instanceId: 'inst-1',
      setStatus: vi.fn(),
      waitFor: vi.fn().mockResolvedValue(waitForValue),
      run: vi.fn(),
      sleep: vi.fn(),
    } as unknown as StepExecutorContext['ctx'],
    stageId,
    config,
    orchestratorUrl: 'http://localhost:3001',
    definition: { id: 'wf-1', name: 'Test', active: true, trigger: { provider: 'manual' }, stages: [], edges: [] },
    workflowContext: workflowContext ?? { trigger: {}, stages: {} },
    input: upstreamInput !== undefined ? { sourceOutput: upstreamInput } : undefined,
    iteration: 1,
  } as unknown as StepExecutorContext;
}

describe('gate executor — auto', () => {
  it('returns { approved: true, input: null } when no upstream input', async () => {
    const ctx = buildCtx('my_gate', { type: 'auto' });
    const executor = gateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { approved: true, input: null } });
  });

  it('passes upstream sourceOutput as input passthrough', async () => {
    const upstream = { text: 'hello', count: 5 };
    const ctx = buildCtx('my_gate', { type: 'auto' }, undefined, upstream);
    const executor = gateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { approved: true, input: upstream } });
  });

  it('uses mergedInputs as passthrough when sourceOutput is absent', async () => {
    const merged = { stage_a: { x: 1 }, stage_b: { y: 2 } };
    const ctx = buildCtx('my_gate', { type: 'auto' });
    (ctx as unknown as { input: unknown }).input = { mergedInputs: merged };
    const executor = gateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect((result.output as { input: unknown }).input).toEqual(merged);
  });

  it('defaults to auto when type is not set', async () => {
    const ctx = buildCtx('my_gate', {});
    const executor = gateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { approved: true, input: null } });
  });
});

describe('gate executor — manual', () => {
  it('returns { approved: true, input: passthrough } when gate is approved', async () => {
    const upstream = { payload: 'data' };
    const ctx = buildCtx('approval_gate', { type: 'manual' }, { approved: true }, upstream);
    const executor = gateNodeSpec.executor as StepExecutor;

    // Patch global fetch to avoid real network call
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      const result = await executor.execute(ctx);
      expect(result).toEqual({ output: { approved: true, input: upstream } });
      expect(ctx.ctx.setStatus).toHaveBeenCalledWith('waiting_gate');
      expect(ctx.ctx.setStatus).toHaveBeenCalledWith('running');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('accepts legacy boolean true approval', async () => {
    const ctx = buildCtx('approval_gate', { type: 'manual' }, true);
    const executor = gateNodeSpec.executor as StepExecutor;
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      const result = await executor.execute(ctx);
      expect((result.output as { approved: boolean }).approved).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('throws TerminalError when gate is rejected', async () => {
    const ctx = buildCtx('approval_gate', { type: 'manual' }, { approved: false });
    const executor = gateNodeSpec.executor as StepExecutor;
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      await expect(executor.execute(ctx)).rejects.toThrowError(TerminalError);
      await expect(executor.execute(ctx)).rejects.toThrow('Gate "approval_gate" was rejected');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('throws TerminalError when legacy boolean false', async () => {
    const ctx = buildCtx('approval_gate', { type: 'manual' }, false);
    const executor = gateNodeSpec.executor as StepExecutor;
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      await expect(executor.execute(ctx)).rejects.toThrowError(TerminalError);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('gate executor — conditional', () => {
  it('returns { approved: true, input: passthrough } when condition passes', async () => {
    const upstream = { score: 99 };
    const ctx = buildCtx(
      'cond_gate',
      { type: 'conditional', condition: 'context.trigger.score > 50' },
      undefined,
      upstream,
      { trigger: { score: 99 }, stages: {} },
    );
    const executor = gateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { approved: true, input: upstream } });
  });

  it('throws TerminalError when condition fails', async () => {
    const ctx = buildCtx(
      'cond_gate',
      { type: 'conditional', condition: 'context.trigger.score > 50' },
      undefined,
      undefined,
      { trigger: { score: 10 }, stages: {} },
    );
    const executor = gateNodeSpec.executor as StepExecutor;

    await expect(executor.execute(ctx)).rejects.toThrowError(TerminalError);
    await expect(executor.execute(ctx)).rejects.toThrow('Gate condition failed for "cond_gate"');
  });
});

describe('gate node spec', () => {
  it('has correct id, category and name', () => {
    expect(gateNodeSpec.id).toBe('gate');
    expect(gateNodeSpec.category).toBe('step');
    expect(gateNodeSpec.name).toBe('Gate');
  });

  it('output_schema configSchema property is readOnly', () => {
    const props = gateNodeSpec.configSchema?.properties as Record<string, { readOnly?: boolean }>;
    expect(props?.output_schema?.readOnly).toBe(true);
  });
});
