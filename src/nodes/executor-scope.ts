import type { StepExecutorContext } from './types.js';

/**
 * Standard execution scope available to all step node executors.
 * Input is always a Record keyed by upstream stage ID.
 * For single-upstream stages: { [sourceStageId]: sourceOutput }
 * For fan-in stages: mergedInputs (already keyed by stage ID)
 * For entry stages with no upstream: {}
 */
export interface ExecutorScope {
  /** All upstream outputs keyed by source stage ID. Always a Record even for single-input. */
  input: Record<string, unknown>;
}

/**
 * Build the standard executor scope from a StepExecutorContext.
 * Used by all step nodes to provide consistent access to upstream data.
 */
export function buildExecutorScope(execCtx: StepExecutorContext): ExecutorScope {
  if (execCtx.input?.mergedInputs) {
    // Fan-in: already keyed by stage ID
    return { input: execCtx.input.mergedInputs };
  }

  const sourceId = execCtx.input?.incomingEdge?.source;
  const sourceOutput = execCtx.input?.sourceOutput;

  if (sourceId && sourceOutput !== undefined) {
    return { input: { [sourceId]: sourceOutput } };
  }

  return { input: {} };
}
