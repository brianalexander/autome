import type { StepExecutorContext } from './types.js';
import type { WorkflowContext } from '../types/instance.js';

/**
 * Standard execution scope available to all step node executors.
 * Provides a consistent interface for accessing upstream data,
 * fan-in outputs, workflow context, and trigger payload.
 */
export interface ExecutorScope {
  /** Output from the primary upstream stage */
  input: unknown;
  /** All upstream outputs keyed by stage ID (populated for fan-in stages) */
  sourceOutputs: Record<string, unknown>;
  /** Full workflow context (context.stages["id"].latest for any stage) */
  context: WorkflowContext;
  /** Original trigger event payload */
  trigger: unknown;
}

/**
 * Build the standard executor scope from a StepExecutorContext.
 * Used by all step nodes to provide consistent access to upstream data.
 */
export function buildExecutorScope(execCtx: StepExecutorContext): ExecutorScope {
  return {
    input: execCtx.input?.sourceOutput ?? {},
    sourceOutputs: execCtx.input?.mergedInputs ?? {},
    context: execCtx.workflowContext,
    trigger: execCtx.workflowContext.trigger,
  };
}
