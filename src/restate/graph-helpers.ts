import type { WorkflowDefinition, EdgeDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import type { WorkflowContext } from '../types/instance.js';
import { nodeRegistry } from '../nodes/registry.js';
import { safeEvalCondition } from '../engine/safe-eval.js';

/** Output from any stage executor — the workflow doesn't know the specific shape */
export type StageOutput = Record<string, unknown>;

// Initialize context from trigger event and definition.
// Trigger stages are marked as completed immediately (with the event payload as output)
// so they appear correctly in the canvas and execution timeline.
export function initializeContext(triggerEvent: Event, definition: WorkflowDefinition): WorkflowContext {
  // Use the trigger event's timestamp — NOT new Date() — so the value is
  // deterministic on Restate journal replay (no side effects outside ctx.run).
  const triggerTimestamp = triggerEvent.timestamp || new Date().toISOString();
  const stages: Record<string, import('../types/instance.js').StageContext> = {};

  for (const stage of definition.stages) {
    if (nodeRegistry.isTriggerType(stage.type)) {
      stages[stage.id] = {
        status: 'completed',
        run_count: 1,
        runs: [
          {
            iteration: 1,
            started_at: triggerTimestamp,
            completed_at: triggerTimestamp,
            status: 'completed',
            output: triggerEvent.payload as Record<string, unknown> | unknown[],
          },
        ],
        latest: triggerEvent.payload as Record<string, unknown> | unknown[],
      };
    } else {
      stages[stage.id] = {
        status: 'pending',
        run_count: 0,
        runs: [],
      };
    }
  }

  return {
    trigger: triggerEvent.payload as Record<string, unknown>,
    stages,
    edgeTraversals: {},
  };
}

// Find entry stages: stages that trigger nodes point to, or stages with no incoming edges
// Trigger stages are excluded from execution (they're event sources, not execution units)
export function findEntryStages(definition: WorkflowDefinition): string[] {
  // Collect IDs of trigger stages (any type registered with category: 'trigger')
  const triggerStageIds = new Set(definition.stages.filter((s) => nodeRegistry.isTriggerType(s.type)).map((s) => s.id));

  // Find stages explicitly connected FROM trigger nodes
  const triggerTargets = definition.edges.filter((e) => triggerStageIds.has(e.source)).map((e) => e.target);

  if (triggerTargets.length > 0) {
    return triggerTargets;
  }

  // Fallback: stages with no incoming edges (excluding trigger stages themselves)
  const targets = new Set(definition.edges.map((e) => e.target));
  return definition.stages.filter((s) => !nodeRegistry.isTriggerType(s.type) && !targets.has(s.id)).map((s) => s.id);
}

// Check if a stage is terminal (no outgoing edges)
export function isTerminalStage(definition: WorkflowDefinition, stageId: string): boolean {
  return !definition.edges.some((e) => e.source === stageId);
}

/** Count how many success-type incoming edges a stage has (excluding on_error edges). */
export function countIncomingSuccessEdges(stageId: string, edges: EdgeDefinition[]): number {
  return edges.filter((e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success').length;
}

/**
 * Record a source stage completion for a fan-in target and check if the target is ready.
 * Returns:
 *   - merged inputs (Record<string, unknown>) if the trigger_rule is satisfied and the target should run
 *   - 'failed' if the trigger_rule can never be satisfied (e.g. all_success with a failed upstream)
 *   - null if still waiting for more upstream completions
 */
export function recordFanInCompletion(
  targetStageId: string,
  sourceStageId: string,
  sourceOutput: unknown,
  sourceStatus: 'completed' | 'failed' | 'skipped',
  context: WorkflowContext,
  definition: WorkflowDefinition,
): Record<string, unknown> | 'failed' | null {
  if (!context.fanInCompletions) context.fanInCompletions = {};
  if (!context.fanInCompletions[targetStageId]) context.fanInCompletions[targetStageId] = {};

  // Store with a status marker so trigger_rule can distinguish success/skip/fail
  context.fanInCompletions[targetStageId][sourceStageId] = { output: sourceOutput, status: sourceStatus };

  const stage = definition.stages.find((s) => s.id === targetStageId);
  const triggerRule = stage?.trigger_rule || 'all_success';
  const incomingEdges = definition.edges.filter(
    (e) => e.target === targetStageId && (e.trigger || 'on_success') === 'on_success',
  );
  const totalExpected = incomingEdges.length;
  const completions = context.fanInCompletions[targetStageId];
  const arrived = Object.keys(completions).length;

  // Extract statuses for evaluation
  const statuses = Object.values(completions).map((c) => (c as { status: string }).status);
  const successCount = statuses.filter((s) => s === 'completed').length;
  const failedCount = statuses.filter((s) => s === 'failed').length;

  let ready = false;
  switch (triggerRule) {
    case 'all_success':
      // All must arrive and all must be 'completed'
      ready = arrived >= totalExpected && failedCount === 0 && successCount > 0;
      // Once any upstream has failed, all_success can never be satisfied.
      // Signal failure immediately rather than waiting for remaining upstreams
      // (which would leave the target hanging indefinitely).
      if (failedCount > 0) {
        return 'failed';
      }
      break;
    case 'any_success':
      // Fire as soon as any one upstream succeeds
      ready = successCount >= 1;
      break;
    case 'none_failed_min_one_success':
      // All must arrive; at least one succeeded, none failed (skipped is OK)
      ready = arrived >= totalExpected && successCount >= 1 && failedCount === 0;
      break;
  }

  if (!ready) return null;

  // Build merged inputs: { sourceStageId: output, ... } for successful sources only
  const merged: Record<string, unknown> = {};
  for (const [srcId, data] of Object.entries(completions)) {
    const entry = data as { status: string; output: unknown };
    if (entry.status === 'completed') {
      merged[srcId] = entry.output;
    }
  }
  return merged;
}

/**
 * Evaluate outgoing edges from a completed or failed stage.
 * @param triggerType - 'on_success' for normal completion, 'on_error' for failure routing
 * @returns Array of matched target stage IDs
 */
export function evaluateEdges(
  stageId: string,
  output: StageOutput | unknown,
  context: WorkflowContext,
  edges: EdgeDefinition[],
  triggerType: 'on_success' | 'on_error' = 'on_success',
): string[] {
  const outgoing = edges.filter((e) => e.source === stageId && (e.trigger || 'on_success') === triggerType);

  if (outgoing.length === 0) {
    return []; // No edges of this type
  }

  if (!context.edgeTraversals) {
    context.edgeTraversals = {};
  }

  const matched: string[] = [];
  for (const edge of outgoing) {
    // Check max_traversals limit
    if (edge.max_traversals != null) {
      const count = context.edgeTraversals[edge.id] || 0;
      if (count >= edge.max_traversals) {
        continue;
      }
    }

    let taken = false;
    if (!edge.condition) {
      taken = true;
    } else {
      try {
        if (safeEvalCondition(edge.condition, { output })) {
          taken = true;
        }
      } catch (err) {
        console.error(`Edge condition evaluation failed for edge ${edge.id}:`, err);
      }
    }

    if (taken) {
      context.edgeTraversals[edge.id] = (context.edgeTraversals[edge.id] || 0) + 1;
      matched.push(edge.target);
    }
  }

  return matched;
}
