import { describe, it, expect, vi } from 'vitest';
import { reviewGateNodeSpec } from '../review-gate.js';
import { TerminalError } from '../../../engine/types.js';
import type { StepExecutor, StepExecutorContext } from '../../types.js';

/**
 * Build a minimal StepExecutorContext that captures gate-${stageId} wait resolution.
 * The `waitForValue` param simulates what the reviewer POSTs to the review endpoint.
 */
function buildCtx(
  stageId: string,
  waitForValue: unknown,
  fetchMock: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({}),
  upstreamInput?: unknown,
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
    config: { message: 'Please review' },
    orchestratorUrl: 'http://localhost:3001',
    definition: { id: 'wf-1', name: 'Test', active: true, trigger: { provider: 'manual' }, stages: [], edges: [] },
    workflowContext: { trigger: {}, stages: {} },
    input: upstreamInput !== undefined ? { sourceOutput: upstreamInput } : undefined,
    iteration: 1,
    _fetch: fetchMock,
  } as unknown as StepExecutorContext;
}

describe('review-gate executor', () => {
  it('returns output with decision=approved and input passthrough when reviewer approves', async () => {
    const decision = { decision: 'approved', notes: 'Looks good' };
    const upstream = { content: 'draft text', score: 42 };
    const ctx = buildCtx('review_stage', decision, vi.fn().mockResolvedValue({}), upstream);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { decision: 'approved', notes: 'Looks good', input: upstream } });
    expect(ctx.ctx.setStatus).toHaveBeenCalledWith('waiting_gate');
    expect(ctx.ctx.setStatus).toHaveBeenCalledWith('running');
  });

  it('returns output with decision=revised and input passthrough when reviewer requests revision', async () => {
    const decision = { decision: 'revised', notes: 'Please fix section 2' };
    const upstream = { content: 'first draft' };
    const ctx = buildCtx('review_stage', decision, vi.fn().mockResolvedValue({}), upstream);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { decision: 'revised', notes: 'Please fix section 2', input: upstream } });
    expect(ctx.ctx.setStatus).toHaveBeenCalledWith('running');
  });

  it('sets input to null when no upstream input is provided', async () => {
    const decision = { decision: 'approved' };
    const ctx = buildCtx('review_stage', decision);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect(result).toEqual({ output: { decision: 'approved', notes: undefined, input: null } });
  });

  it('uses mergedInputs as passthrough when sourceOutput is absent', async () => {
    const decision = { decision: 'approved' };
    const merged = { stage_a: { foo: 1 }, stage_b: { bar: 2 } };
    const ctx = buildCtx('review_stage', decision);
    // Override input to use mergedInputs
    (ctx as unknown as { input: unknown }).input = { mergedInputs: merged };
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    const result = await executor.execute(ctx);

    expect((result.output as { input: unknown }).input).toEqual(merged);
  });

  it('throws TerminalError with notes when reviewer rejects', async () => {
    const decision = { decision: 'rejected', notes: 'Does not meet requirements' };
    const ctx = buildCtx('review_stage', decision);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    await expect(executor.execute(ctx)).rejects.toThrowError(TerminalError);
    await expect(executor.execute(ctx)).rejects.toThrow(
      'Review "review_stage" rejected: Does not meet requirements',
    );
  });

  it('throws TerminalError without notes when reviewer rejects with no notes', async () => {
    const decision = { decision: 'rejected' };
    const ctx = buildCtx('review_stage', decision);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    await expect(executor.execute(ctx)).rejects.toThrowError(TerminalError);
    await expect(executor.execute(ctx)).rejects.toThrow(
      'Review "review_stage" rejected',
    );
    // Ensure no trailing colon — confirm it doesn't end with a colon+space pattern
    try {
      await executor.execute(ctx);
    } catch (err) {
      expect((err as Error).message).not.toMatch(/rejected:$/);
    }
  });

  it('broadcasts waiting_gate status with gateKind=review', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const decision = { decision: 'approved' };
    const ctx = buildCtx('my_review', decision, fetchMock);
    const executor = reviewGateNodeSpec.executor as StepExecutor;

    // Override global fetch
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      await executor.execute(ctx);
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/internal/workflow-status',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"gateKind":"review"'),
      }),
    );
  });

  it('spec has correct id and category', () => {
    expect(reviewGateNodeSpec.id).toBe('review-gate');
    expect(reviewGateNodeSpec.category).toBe('step');
    expect(reviewGateNodeSpec.name).toBe('Review Gate');
  });

  it('spec defaultConfig output_schema does not include a data property', () => {
    const schema = reviewGateNodeSpec.defaultConfig?.output_schema as {
      properties?: Record<string, unknown>;
    };
    expect(schema?.properties).toBeDefined();
    expect(schema?.properties?.data).toBeUndefined();
    expect(schema?.properties?.input).toBeDefined();
  });
});
