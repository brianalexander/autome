import * as restate from '@restatedev/restate-sdk';
import type { WorkflowDefinition, EdgeDefinition, StageDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import type { StageContext, WorkflowContext } from '../types/instance.js';
import { nodeRegistry } from '../nodes/registry.js';
import type { StepExecutorContext, NodeTypeSpec, StageInput } from '../nodes/types.js';
import { safeEvalCondition } from '../engine/safe-eval.js';
import { resolveTemplateValue } from '../engine/context-resolver.js';
import { config as appConfig } from '../config.js';

// Re-export WorkflowContext for existing consumers
export type { WorkflowContext };

/** Output from any stage executor — the workflow doesn't know the specific shape */
type StageOutput = Record<string, unknown>;

// Types for workflow input/state
interface WorkflowInput {
  definition: WorkflowDefinition;
  triggerEvent: Event;
}

export interface WorkflowState {
  status: string;
  context: WorkflowContext;
  currentStageIds: string[];
}

// Initialize context from trigger event and definition.
// Trigger stages are marked as completed immediately (with the event payload as output)
// so they appear correctly in the canvas and execution timeline.
export function initializeContext(triggerEvent: Event, definition: WorkflowDefinition): WorkflowContext {
  // Use the trigger event's timestamp — NOT new Date() — so the value is
  // deterministic on Restate journal replay (no side effects outside ctx.run).
  const triggerTimestamp = triggerEvent.timestamp || new Date().toISOString();
  const stages: Record<string, StageContext> = {};

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
            output: triggerEvent.payload,
          },
        ],
        latest: triggerEvent.payload,
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
    trigger: triggerEvent.payload,
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

// The workflow definition
export const pipelineWorkflow = restate.workflow({
  name: 'pipeline',
  handlers: {
    // Main run handler — executes exactly once per workflow ID
    run: async (ctx: restate.WorkflowContext, input: WorkflowInput): Promise<WorkflowContext> => {
      const { definition, triggerEvent } = input;
      const orchestratorUrl = appConfig.orchestratorUrl;
      const context = initializeContext(triggerEvent, definition);

      ctx.set('status', 'running');
      ctx.set('context', context);
      ctx.set('currentStageIds', [] as string[]);

      // Find entry stages and execute the graph
      const entryStages = findEntryStages(definition);

      if (entryStages.length === 0) {
        throw new restate.TerminalError('Workflow has no entry stages (all stages have incoming edges)');
      }

      try {
        await executeStages(ctx, entryStages, definition, context);

        ctx.set('status', 'completed');
        ctx.set('context', context);

        // Notify backend to sync DB
        await ctx.run('notify-completed', async () => {
          await fetch(`${orchestratorUrl}/api/internal/workflow-finished`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceId: ctx.key, status: 'completed', context }),
          }).catch((err) => {
            console.error('[workflow] Context sync failed:', err);
          });
          return { notified: true };
        });

        return context;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Mark any stages still "running" as "failed" with the error
        const errorTimestamp = await ctx.run('timestamp-error', () => new Date().toISOString());
        for (const [sid, sctx] of Object.entries(context.stages)) {
          if (sctx.status === 'running') {
            sctx.status = 'failed';
            const lastRun = sctx.runs[sctx.runs.length - 1];
            if (lastRun && lastRun.status === 'running') {
              lastRun.status = 'failed';
              lastRun.completed_at = errorTimestamp;
              lastRun.error = errorMsg;
            } else {
              // No run entry yet — create one
              sctx.runs.push({
                iteration: sctx.run_count || 1,
                started_at: errorTimestamp,
                completed_at: errorTimestamp,
                status: 'failed',
                error: errorMsg,
              });
            }
          }
        }

        ctx.set('status', 'failed');
        ctx.set('context', context);

        // Notify backend to sync DB on failure
        await ctx.run('notify-failed', async () => {
          await fetch(`${orchestratorUrl}/api/internal/workflow-finished`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instanceId: ctx.key,
              status: 'failed',
              context,
              error: errorMsg,
            }),
          }).catch((err) => {
            console.error('[workflow] Context sync failed:', err);
          });
          return { notified: true };
        });

        throw err;
      }
    },

    // --- Shared handlers (callable while workflow is running) ---

    approveGate: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; data?: unknown },
    ): Promise<string> => {
      await ctx.promise<{ approved: boolean; data?: unknown }>(`gate-${input.stageId}`).resolve({
        approved: true,
        data: input.data,
      });
      return `Gate ${input.stageId} approved`;
    },

    rejectGate: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; reason?: string },
    ): Promise<string> => {
      await ctx.promise<{ approved: boolean }>(`gate-${input.stageId}`).resolve({ approved: false });
      return `Gate ${input.stageId} rejected: ${input.reason || 'no reason given'}`;
    },

    injectMessage: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; message: string },
    ): Promise<string> => {
      await ctx.promise<string>(`human-input-${input.stageId}`).resolve(input.message);
      return 'Message injected';
    },

    stageComplete: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; output: StageOutput },
    ): Promise<string> => {
      await ctx.promise<StageOutput>(`stage-complete-${input.stageId}`).resolve(input.output);
      return `Stage ${input.stageId} output recorded`;
    },

    stageFailed: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; error: string },
    ): Promise<string> => {
      // Reject the durable promise — causes the awaiting .get() to throw a TerminalError
      await ctx.promise<StageOutput>(`stage-complete-${input.stageId}`).reject(input.error);
      return `Stage ${input.stageId} marked as failed`;
    },

    stageStatus: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; status: string; message: string },
    ): Promise<string> => {
      // Resolve a named durable promise so the run handler can observe status updates if needed.
      // WorkflowSharedContext does not allow set() — only the run handler (WorkflowContext) can mutate state.
      await ctx
        .promise<{ status: string; message: string }>(`stage-status-${input.stageId}`)
        .resolve({ status: input.status, message: input.message });
      return 'Status updated';
    },

    getStatus: async (ctx: restate.WorkflowSharedContext): Promise<WorkflowState> => {
      return {
        status: (await ctx.get<string>('status')) || 'unknown',
        context: (await ctx.get<WorkflowContext>('context')) || { trigger: {}, stages: {} },
        currentStageIds: (await ctx.get<string[]>('currentStageIds')) || [],
      };
    },

    respondToInput: async (
      ctx: restate.WorkflowSharedContext,
      input: { stageId: string; response: string },
    ): Promise<string> => {
      await ctx.promise<string>(`input-response-${input.stageId}`).resolve(input.response);
      return 'Input response delivered';
    },
  },
});

// --- Graph execution logic ---


// ---------------------------------------------------------------------------
// Fan-in helpers
// ---------------------------------------------------------------------------

/** Count how many success-type incoming edges a stage has (excluding on_error edges). */
function countIncomingSuccessEdges(stageId: string, edges: EdgeDefinition[]): number {
  return edges.filter((e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success').length;
}

/**
 * Record a source stage completion for a fan-in target and check if the target is ready.
 * Returns the merged inputs if the target's trigger_rule is satisfied, or null if still waiting.
 */
function recordFanInCompletion(
  targetStageId: string,
  sourceStageId: string,
  sourceOutput: unknown,
  sourceStatus: 'completed' | 'failed' | 'skipped',
  context: WorkflowContext,
  definition: WorkflowDefinition,
): Record<string, unknown> | null {
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
      // If any failed, we'll never satisfy all_success — mark target as failed
      if (failedCount > 0 && arrived >= totalExpected) {
        return null; // Caller handles the failure case
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

// ---------------------------------------------------------------------------
// Skip propagation
// ---------------------------------------------------------------------------

/**
 * Propagate skip status downstream from a stage that was skipped.
 * Marks all reachable stages as 'skipped' unless they have other non-skipped incoming paths.
 * For fan-in nodes, records the skip and checks trigger_rule.
 */
async function propagateSkip(
  ctx: restate.WorkflowContext,
  sourceStageId: string,
  definition: WorkflowDefinition,
  context: WorkflowContext,
): Promise<void> {
  const outgoing = definition.edges.filter(
    (e) => e.source === sourceStageId && (e.trigger || 'on_success') === 'on_success',
  );

  for (const edge of outgoing) {
    const targetId = edge.target;
    const incomingCount = countIncomingSuccessEdges(targetId, definition.edges);

    if (incomingCount > 1) {
      // Fan-in node — record this skip and check trigger_rule
      const merged = recordFanInCompletion(targetId, sourceStageId, undefined, 'skipped', context, definition);
      if (merged) {
        // Trigger rule satisfied despite skip — execute the stage with merged inputs
        const targetStage = definition.stages.find((s) => s.id === targetId);
        const spec = targetStage ? nodeRegistry.get(targetStage.type) : null;
        if (targetStage && spec && spec.executor.type === 'step') {
          await executeStepWithLifecycle(ctx, targetId, targetStage, definition, context, spec, {
            mergedInputs: merged,
          });
        }
      }
      // If not ready yet, other upstream completions will trigger it later
      continue;
    }

    // Single incoming edge — propagate skip
    if (context.stages[targetId]?.status === 'pending') {
      context.stages[targetId].status = 'skipped';
      ctx.set('context', context);
      // Recursively propagate
      await propagateSkip(ctx, targetId, definition, context);
    }
  }
}

// ---------------------------------------------------------------------------
// Edge evaluation
// ---------------------------------------------------------------------------

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
        if (safeEvalCondition(edge.condition, { output, context })) {
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

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function executeWithRetry(
  ctx: restate.WorkflowContext,
  stageId: string,
  stage: StageDefinition,
  spec: NodeTypeSpec,
  config: Record<string, unknown>,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  input: StageInput | undefined,
  orchestratorUrl: string,
  iteration: number,
): Promise<{ output: unknown }> {
  const retryConfig = stage.retry;
  const maxAttempts = retryConfig?.max_attempts ?? 1;
  const baseDelay = retryConfig?.delay_ms ?? 1000;
  const backoff = retryConfig?.backoff_multiplier ?? 2;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const execCtx: StepExecutorContext = {
        ctx,
        stageId,
        config,
        definition,
        workflowContext: context,
        input,
        orchestratorUrl,
        iteration,
      };
      const result = await (spec.executor as import('../nodes/types.js').StepExecutor).execute(execCtx);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(backoff, attempt - 1);
        console.warn(
          `[workflow] Stage "${stageId}" attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await ctx.sleep(delay);
      }
    }
  }

  throw new restate.TerminalError(lastError!.message);
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

async function syncContextToDb(
  ctx: restate.WorkflowContext,
  label: string,
  orchestratorUrl: string,
  instanceId: string,
  context: WorkflowContext,
  extra?: Record<string, unknown>,
): Promise<void> {
  await ctx.run(label, async () => {
    await fetch(`${orchestratorUrl}/api/internal/workflow-context-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId, context, ...extra }),
    }).catch((err) => {
      console.error('[workflow] Context sync failed:', err);
    });
    return { synced: true };
  });
}

// ---------------------------------------------------------------------------
// Stage execution
// ---------------------------------------------------------------------------

async function executeStages(
  ctx: restate.WorkflowContext,
  stageIds: string[],
  definition: WorkflowDefinition,
  context: WorkflowContext,
  inputs?: Map<string, StageInput>,
): Promise<void> {
  if (stageIds.length === 0) return;

  ctx.set('currentStageIds', stageIds);

  for (const stageId of stageIds) {
    await executeSingleStage(ctx, stageId, definition, context, inputs?.get(stageId));
  }
}

async function executeSingleStage(
  ctx: restate.WorkflowContext,
  stageId: string,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  input?: StageInput,
): Promise<void> {
  const stage = definition.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw new restate.TerminalError(`Stage "${stageId}" not found in workflow definition`);
  }

  const spec = nodeRegistry.get(stage.type);
  if (!spec) {
    throw new restate.TerminalError(`Unknown node type "${stage.type}" for stage "${stageId}"`);
  }

  if (spec.executor.type === 'trigger') {
    return; // Triggers are entry-point markers
  }

  // --- Fan-in check: does this stage have multiple incoming success edges? ---
  const incomingSuccessEdges = definition.edges.filter(
    (e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success',
  );

  if (incomingSuccessEdges.length > 1 && !input?.mergedInputs) {
    // This is a fan-in target reached from one of its sources.
    // Record this source's output and check if all sources are ready.
    const sourceStageId = input?.incomingEdge?.source;
    if (sourceStageId) {
      const merged = recordFanInCompletion(
        stageId,
        sourceStageId,
        input?.sourceOutput,
        'completed',
        context,
        definition,
      );
      ctx.set('context', context);

      if (!merged) {
        // Not all sources ready yet — this branch stops here, other sources will continue
        return;
      }
      // All sources ready — proceed with merged input
      input = { ...input, mergedInputs: merged };
    }
  }

  // --- Cycle re-entry detection: stage has already run in this execution ---
  // For multi-hop cycles (A→B→A), the routing goes through normal edge evaluation
  // so the self-loop path doesn't apply. We detect re-entry here and inject
  // priorSessionId if cycle_behavior is 'continue', so the agent can resume its session.
  if (context.stages[stageId].run_count > 0) {
    const stageConfig = stage.config || {};
    const cycleBehavior = (stageConfig.cycle_behavior as string) || 'fresh';
    if (cycleBehavior === 'continue') {
      input = {
        ...input,
        isCycleReentry: true,
        priorSessionId: `${ctx.key}:${stageId}`,
      };
    } else {
      input = {
        ...input,
        isCycleReentry: true,
      };
    }
  }

  // --- Dynamic map: execute stage once per array element ---
  if (stage.map_over) {
    await executeMapStage(ctx, stageId, stage, definition, context, spec, input);
    return;
  }

  await executeStepWithLifecycle(ctx, stageId, stage, definition, context, spec, input);
}

// ---------------------------------------------------------------------------
// Dynamic map execution
// ---------------------------------------------------------------------------

async function executeMapStage(
  ctx: restate.WorkflowContext,
  stageId: string,
  stage: StageDefinition,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  spec: NodeTypeSpec,
  input?: StageInput,
): Promise<void> {
  const orchestratorUrl = appConfig.orchestratorUrl;

  // Resolve the map_over expression to an array
  const rawValue = resolveTemplateValue(stage.map_over!, context);
  if (!Array.isArray(rawValue)) {
    throw new restate.TerminalError(
      `Stage "${stageId}" map_over expression did not resolve to an array: got ${typeof rawValue}`,
    );
  }

  const items = rawValue as unknown[];
  const concurrency = stage.concurrency ?? items.length; // Default: unlimited
  const failureTolerance = stage.failure_tolerance ?? 0;
  const results: unknown[] = new Array(items.length).fill(null);
  let failureCount = 0;

  // Process items in batches of `concurrency`
  for (let batchStart = 0; batchStart < items.length; batchStart += concurrency) {
    const batchEnd = Math.min(batchStart + concurrency, items.length);

    for (let i = batchStart; i < batchEnd; i++) {
      const mapInput: StageInput = {
        ...input,
        mapElement: items[i],
        mapIndex: i,
        sourceOutput: items[i],
      };

      // Create a sub-context entry for this map iteration
      const mapStageKey = `${stageId}[${i}]`;
      if (!context.stages[mapStageKey]) {
        context.stages[mapStageKey] = { status: 'pending', run_count: 0, runs: [] };
      }

      try {
        // Execute using the retry-aware executor directly
        const config: Record<string, unknown> = stage.config || {};
        const runStartedAt = await ctx.run(`timestamp-start-${mapStageKey}`, () => new Date().toISOString());
        context.stages[mapStageKey].status = 'running';
        context.stages[mapStageKey].run_count = 1;
        context.stages[mapStageKey].runs.push({ iteration: 1, started_at: runStartedAt, status: 'running' as const });
        ctx.set('context', context);

        const result = await executeWithRetry(
          ctx,
          stageId,
          stage,
          spec,
          config,
          definition,
          context,
          mapInput,
          orchestratorUrl,
          i + 1,
        );
        results[i] = result.output;

        const completedAt = await ctx.run(`timestamp-done-${mapStageKey}`, () => new Date().toISOString());
        const run = context.stages[mapStageKey].runs[context.stages[mapStageKey].runs.length - 1];
        if (run) {
          run.status = 'completed';
          run.completed_at = completedAt;
          run.output = result.output;
          const mapLogs = (result as any).logs as string | undefined;
          const mapStderr = (result as any).stderr as string | undefined;
          if (mapLogs) run.logs = mapLogs;
          if (mapStderr) run.stderr = mapStderr;
        }
        context.stages[mapStageKey].status = 'completed';
        context.stages[mapStageKey].latest = result.output;
      } catch (err) {
        failureCount++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        const failedAt = await ctx.run(`timestamp-fail-${mapStageKey}`, () => new Date().toISOString());
        const run = context.stages[mapStageKey].runs[context.stages[mapStageKey].runs.length - 1];
        if (run) {
          run.status = 'failed';
          run.completed_at = failedAt;
          run.error = errorMsg;
        }
        context.stages[mapStageKey].status = 'failed';
        ctx.set('context', context);

        if (failureCount > failureTolerance) {
          throw new restate.TerminalError(
            `Stage "${stageId}" map failed: ${failureCount} failures exceeded tolerance of ${failureTolerance}. Last error: ${errorMsg}`,
          );
        }
        results[i] = { _error: errorMsg };
      }
    }
  }

  // Store collected results as the stage output
  context.stages[stageId].latest = results;
  context.stages[stageId].status = 'completed';
  ctx.set('context', context);
  await syncContextToDb(ctx, `sync-map-done-${stageId}`, orchestratorUrl, ctx.key, context);

  // Route downstream
  await routeDownstream(ctx, stageId, results, definition, context);
}

// ---------------------------------------------------------------------------
// Step lifecycle (single execution with retry + error edges)
// ---------------------------------------------------------------------------

/**
 * Shared lifecycle wrapper for all step node executors.
 * Handles: iteration loop (for cycles), run entry management, retry with backoff,
 * error edge routing, context syncing, output validation, and edge evaluation/routing.
 */
async function executeStepWithLifecycle(
  ctx: restate.WorkflowContext,
  stageId: string,
  stage: StageDefinition,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  spec: NodeTypeSpec,
  input?: StageInput,
): Promise<void> {
  const orchestratorUrl = appConfig.orchestratorUrl;
  const config: Record<string, unknown> = stage.config || {};
  const maxIterations = (config.max_iterations as number) ?? 5;
  let iteration = context.stages[stageId].run_count || 0;
  let currentInput = input;

  while (true) {
    iteration++;

    if (iteration > maxIterations) {
      throw new restate.TerminalError(`Max iterations (${maxIterations}) exceeded for stage "${stageId}"`);
    }

    // --- Start run ---
    const runStartedAt = await ctx.run(`timestamp-start-${stageId}-${iteration}`, () => new Date().toISOString());
    context.stages[stageId].status = 'running';
    context.stages[stageId].run_count = iteration;
    context.stages[stageId].runs.push({
      iteration,
      started_at: runStartedAt,
      status: 'running' as const,
    });
    ctx.set('context', context);
    ctx.set('status', 'running');

    await syncContextToDb(ctx, `sync-context-running-${stageId}-${iteration}`, orchestratorUrl, ctx.key, context, {
      currentStageIds: [stageId],
    });

    // --- Execute the node (with retry) ---
    let output: unknown;
    let stageLogs: string | undefined;
    let stageStderr: string | undefined;
    try {
      const result = await executeWithRetry(
        ctx,
        stageId,
        stage,
        spec,
        config,
        definition,
        context,
        currentInput,
        orchestratorUrl,
        iteration,
      );
      output = result.output;
      stageLogs = (result as any).logs as string | undefined;
      stageStderr = (result as any).stderr as string | undefined;
    } catch (err) {
      // All retries exhausted — mark failed
      const failedAt = await ctx.run(`timestamp-fail-${stageId}-${iteration}`, () => new Date().toISOString());
      const currentRunFail = context.stages[stageId].runs[context.stages[stageId].runs.length - 1];
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (currentRunFail) {
        currentRunFail.status = 'failed';
        currentRunFail.completed_at = failedAt;
        currentRunFail.error = errorMsg;
      }
      context.stages[stageId].status = 'failed';
      ctx.set('context', context);

      await syncContextToDb(ctx, `sync-context-fail-${stageId}-${iteration}`, orchestratorUrl, ctx.key, context);

      // --- Error edge routing: check for on_error edges ---
      const errorEdgeTargets = evaluateEdges(
        stageId,
        { error: errorMsg, stageId },
        context,
        definition.edges,
        'on_error',
      );
      if (errorEdgeTargets.length > 0) {
        // Route to error handlers instead of throwing
        const errorOutput = { error: errorMsg, stageId, lastOutput: context.stages[stageId].latest };
        const errorInputs = new Map<string, StageInput>();
        const errorEdges = definition.edges.filter(
          (e) => e.source === stageId && (e.trigger || 'on_success') === 'on_error',
        );
        for (const targetId of errorEdgeTargets) {
          const edge = errorEdges.find((e) => e.target === targetId);
          if (edge) {
            errorInputs.set(targetId, { incomingEdge: edge, sourceOutput: errorOutput });
          }
        }
        await executeStages(ctx, errorEdgeTargets, definition, context, errorInputs);

        // Also propagate skip to on_success downstream (they won't fire since this stage failed)
        await propagateSkip(ctx, stageId, definition, context);
        return;
      }

      throw new restate.TerminalError(`Stage "${stageId}" failed: ${errorMsg}`);
    }

    // --- Complete run ---
    const outgoingEdges = definition.edges.filter((e) => e.source === stageId);

    const completedAt = await ctx.run(`timestamp-done-${stageId}-${iteration}`, () => new Date().toISOString());
    const currentRun = context.stages[stageId].runs[context.stages[stageId].runs.length - 1];
    if (currentRun) {
      currentRun.status = 'completed';
      currentRun.completed_at = completedAt;
      currentRun.output = output;
      if (stageLogs) currentRun.logs = stageLogs;
      if (stageStderr) currentRun.stderr = stageStderr;
    }
    context.stages[stageId].latest = output;
    context.stages[stageId].status = 'completed';
    ctx.set('context', context);

    await syncContextToDb(ctx, `sync-context-done-${stageId}-${iteration}`, orchestratorUrl, ctx.key, context);

    // --- Edge evaluation and routing ---
    const nextStageIds = evaluateEdges(stageId, output, context, definition.edges, 'on_success');

    // If no success edges matched but conditional edges exist, propagate skip
    const successEdges = outgoingEdges.filter((e) => (e.trigger || 'on_success') === 'on_success');
    if (nextStageIds.length === 0 && successEdges.length > 0 && successEdges.some((e) => e.condition)) {
      // Some conditional edges exist but none matched — skip downstream
      await propagateSkip(ctx, stageId, definition, context);
      break;
    }

    const nextInputs = new Map<string, StageInput>();
    for (const nextId of nextStageIds) {
      const edge = outgoingEdges.find((e) => e.target === nextId);
      if (edge) {
        const isCycleBack = nextId === stageId;
        nextInputs.set(nextId, {
          incomingEdge: edge,
          sourceOutput: output,
          isCycleReentry: isCycleBack,
        });
      }
    }

    // Check if any next stage is this same stage (cycle back)
    if (nextStageIds.includes(stageId)) {
      // Read cycle_behavior from THIS stage's config (we're cycling back to ourselves)
      const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
      currentInput = {
        ...nextInputs.get(stageId),
        isCycleReentry: true,
        // For 'continue' mode, pass the session ID so spawn-agent can resume
        ...(cycleBehavior === 'continue' ? { priorSessionId: `${ctx.key}:${stageId}` } : {}),
      };
      const otherStages = nextStageIds.filter((id) => id !== stageId);
      if (otherStages.length > 0) {
        await executeStages(ctx, otherStages, definition, context, nextInputs);
      }
      continue;
    }

    // No cycle — execute next stages and break
    if (nextStageIds.length > 0) {
      await executeStages(ctx, nextStageIds, definition, context, nextInputs);
    }
    break;
  }

  // After the cycle exits: clean up lingering ACP sessions for 'continue' mode.
  // (If cycle_behavior is 'fresh', the session was killed after each iteration already.)
  const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
  if (cycleBehavior === 'continue' && iteration > 1) {
    await ctx.run(`cleanup-session-${stageId}`, async () => {
      await fetch(`${appConfig.orchestratorUrl}/api/internal/kill-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: ctx.key, stageId }),
      }).catch(() => {});
      return { cleaned: true };
    });
  }
}

// ---------------------------------------------------------------------------
// Downstream routing helper
// ---------------------------------------------------------------------------

async function routeDownstream(
  ctx: restate.WorkflowContext,
  stageId: string,
  output: unknown,
  definition: WorkflowDefinition,
  context: WorkflowContext,
): Promise<void> {
  const nextStageIds = evaluateEdges(stageId, output, context, definition.edges, 'on_success');
  const outgoingEdges = definition.edges.filter((e) => e.source === stageId);

  // Skip propagation if no edges matched
  const successEdges = outgoingEdges.filter((e) => (e.trigger || 'on_success') === 'on_success');
  if (nextStageIds.length === 0 && successEdges.length > 0 && successEdges.some((e) => e.condition)) {
    await propagateSkip(ctx, stageId, definition, context);
    return;
  }

  if (nextStageIds.length > 0) {
    const nextInputs = new Map<string, StageInput>();
    for (const nextId of nextStageIds) {
      const edge = outgoingEdges.find((e) => e.target === nextId);
      if (edge) {
        nextInputs.set(nextId, { incomingEdge: edge, sourceOutput: output });
      }
    }
    await executeStages(ctx, nextStageIds, definition, context, nextInputs);
  }
}
