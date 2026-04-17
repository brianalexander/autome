import type { WorkflowDefinition, StageDefinition } from '../types/workflow.js';
import type { WorkflowContext } from '../types/instance.js';
import { nodeRegistry } from '../nodes/registry.js';
import type { NodeTypeSpec, StageInput } from '../nodes/types.js';
import { config as appConfig } from '../config.js';
import type { ExecutionContext } from './types.js';
import { TerminalError, isTerminalError } from './types.js';
import {
  evaluateEdges,
  recordFanInCompletion,
  countIncomingSuccessEdges,
  type StageOutput,
} from './graph-helpers.js';
import { resolveTemplateValue } from '../engine/context-resolver.js';
import { getSecretsSnapshot } from '../secrets/service.js';

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

export async function executeWithRetry(
  execCtx: ExecutionContext,
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
      const result = await (spec.executor as import('../nodes/types.js').StepExecutor).execute({
        ctx: execCtx,
        stageId,
        config,
        definition,
        workflowContext: context,
        input,
        orchestratorUrl,
        iteration,
        secrets: getSecretsSnapshot(),
      });
      return result as { output: unknown };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(backoff, attempt - 1);
        console.warn(
          `[engine] Stage "${stageId}" attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await execCtx.sleep(delay);
      }
    }
  }

  throw new TerminalError(lastError!.message);
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

export async function syncContextToDb(
  execCtx: ExecutionContext,
  _label: string,
  context: WorkflowContext,
  extra?: Record<string, unknown>,
): Promise<void> {
  // In the engine, setContext already syncs to DB synchronously.
  // This function exists to match the signature surface of the Restate version.
  execCtx.setContext(context);
  if (extra?.currentStageIds) {
    execCtx.setCurrentStageIds(extra.currentStageIds as string[]);
  }
}

// ---------------------------------------------------------------------------
// Skip propagation
// ---------------------------------------------------------------------------

/**
 * Propagate skip status downstream from a stage that was skipped.
 * Marks all reachable stages as 'skipped' unless they have other non-skipped incoming paths.
 * For fan-in nodes, records the skip and checks trigger_rule.
 */
export async function propagateSkip(
  execCtx: ExecutionContext,
  sourceStageId: string,
  definition: WorkflowDefinition,
  context: WorkflowContext,
): Promise<void> {
  const outgoing = definition.edges.filter(
    (e) => e.source === sourceStageId && (e.trigger || 'on_success') === 'on_success',
  );

  for (const edge of outgoing) {
    const targetId = edge.target;
    const targetStage = definition.stages.find((s) => s.id === targetId);
    const targetInputMode = targetStage?.input_mode || 'queue';
    const incomingCount = countIncomingSuccessEdges(targetId, definition.edges);

    if (targetInputMode === 'fan_in' && incomingCount > 1) {
      // Fan-in node — record this skip and check trigger_rule
      const merged = recordFanInCompletion(targetId, sourceStageId, undefined, 'skipped', context, definition);
      if (merged === 'failed') {
        throw new TerminalError(
          `Stage "${targetId}" fan-in failed: upstream stage "${sourceStageId}" failed and trigger_rule is all_success`,
        );
      }
      if (merged) {
        const spec = targetStage ? nodeRegistry.get(targetStage.type) : null;
        if (targetStage && spec && spec.executor.type === 'step') {
          await executeStepWithLifecycle(execCtx, targetId, targetStage, definition, context, spec, {
            mergedInputs: merged,
          });
        }
      }
      continue;
    }

    // Single incoming edge (or queue mode) — propagate skip
    if (context.stages[targetId]?.status === 'pending') {
      context.stages[targetId].status = 'skipped';
      execCtx.setContext(context);
      await propagateSkip(execCtx, targetId, definition, context);
    }
  }

  await syncContextToDb(execCtx, `sync-skip-${sourceStageId}`, context);
}

// ---------------------------------------------------------------------------
// Stage execution
// ---------------------------------------------------------------------------

export async function executeStages(
  execCtx: ExecutionContext,
  stageIds: string[],
  definition: WorkflowDefinition,
  context: WorkflowContext,
  inputs?: Map<string, StageInput>,
): Promise<void> {
  if (stageIds.length === 0) return;

  execCtx.setCurrentStageIds(stageIds);

  // Execute stages in parallel — critical for fan-out patterns
  await Promise.all(
    stageIds.map((stageId) => executeSingleStage(execCtx, stageId, definition, context, inputs?.get(stageId))),
  );
}

export async function executeSingleStage(
  execCtx: ExecutionContext,
  stageId: string,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  input?: StageInput,
): Promise<void> {
  const stage = definition.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw new TerminalError(`Stage "${stageId}" not found in workflow definition`);
  }

  const spec = nodeRegistry.get(stage.type);
  if (!spec) {
    throw new TerminalError(`Unknown node type "${stage.type}" for stage "${stageId}"`);
  }

  if (spec.executor.type === 'trigger') {
    return; // Triggers are entry-point markers
  }

  const inputMode = stage.input_mode || 'queue';

  if (inputMode === 'fan_in') {
    // --- Fan-in check: does this stage have multiple incoming success edges? ---
    const incomingSuccessEdges = definition.edges.filter(
      (e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success',
    );

    if (incomingSuccessEdges.length > 1 && !input?.mergedInputs) {
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
        execCtx.setContext(context);

        if (merged === 'failed') {
          throw new TerminalError(
            `Stage "${stageId}" fan-in failed: upstream stage "${sourceStageId}" failed and trigger_rule is all_success`,
          );
        }

        if (!merged) {
          return;
        }
        input = { ...input, mergedInputs: merged };
      }
    }
  } else {
    // --- Queue mode: serialize executions FIFO ---
    if (context.stages[stageId]?.status === 'running') {
      if (!context.pendingInputs) context.pendingInputs = {};
      if (!context.pendingInputs[stageId]) context.pendingInputs[stageId] = [];
      context.pendingInputs[stageId].push({
        incomingEdge: input?.incomingEdge,
        sourceOutput: input?.sourceOutput,
      });
      execCtx.setContext(context);
      return;
    }
  }

  // --- Dynamic map: execute stage once per array element ---
  if (stage.map_over) {
    await executeMapStage(execCtx, stageId, stage, definition, context, spec, input);
    await drainQueuedInputs(execCtx, stageId, stage, definition, context, inputMode);
    return;
  }

  await executeStepWithLifecycle(execCtx, stageId, stage, definition, context, spec, input);
  await drainQueuedInputs(execCtx, stageId, stage, definition, context, inputMode);
}

/**
 * In queue mode, after a stage finishes, process any inputs that arrived while it was running.
 */
async function drainQueuedInputs(
  execCtx: ExecutionContext,
  stageId: string,
  stage: StageDefinition,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  inputMode: string,
): Promise<void> {
  if (inputMode !== 'queue') return;

  while (context.pendingInputs?.[stageId]?.length) {
    const nextInput = context.pendingInputs[stageId].shift()!;
    execCtx.setContext(context);

    const spec = nodeRegistry.get(stage.type)!;
    const stageInput: StageInput = {
      incomingEdge: nextInput.incomingEdge as import('../types/workflow.js').EdgeDefinition | undefined,
      sourceOutput: nextInput.sourceOutput,
    };

    if (stage.map_over) {
      await executeMapStage(execCtx, stageId, stage, definition, context, spec, stageInput);
    } else {
      await executeStepWithLifecycle(execCtx, stageId, stage, definition, context, spec, stageInput);
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic map execution
// ---------------------------------------------------------------------------

async function executeMapStage(
  execCtx: ExecutionContext,
  stageId: string,
  stage: StageDefinition,
  definition: WorkflowDefinition,
  context: WorkflowContext,
  spec: NodeTypeSpec,
  input?: StageInput,
): Promise<void> {
  const orchestratorUrl = appConfig.orchestratorUrl;

  const rawValue = resolveTemplateValue(stage.map_over!, context);
  if (!Array.isArray(rawValue)) {
    throw new TerminalError(
      `Stage "${stageId}" map_over expression did not resolve to an array: got ${typeof rawValue}`,
    );
  }

  const items = rawValue as unknown[];

  if (items.length === 0) {
    context.stages[stageId].latest = [];
    context.stages[stageId].status = 'completed';
    execCtx.setContext(context);
    await routeDownstream(execCtx, stageId, [], definition, context);
    return;
  }

  const concurrency = stage.concurrency ?? items.length;
  const failureTolerance = stage.failure_tolerance ?? 0;
  const results: unknown[] = new Array(items.length).fill(null);
  let failureCount = 0;

  const config: Record<string, unknown> = stage.config || {};

  for (let batchStart = 0; batchStart < items.length; batchStart += concurrency) {
    const batchEnd = Math.min(batchStart + concurrency, items.length);

    const batchPromises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      batchPromises.push((async () => {
        const mapInput: StageInput = {
          ...input,
          mapElement: items[i],
          mapIndex: i,
          sourceOutput: items[i],
        };

        const mapStageKey = `${stageId}[${i}]`;
        if (!context.stages[mapStageKey]) {
          context.stages[mapStageKey] = { status: 'pending', run_count: 0, runs: [] };
        }

        try {
          const runStartedAt = new Date().toISOString();
          context.stages[mapStageKey].status = 'running';
          context.stages[mapStageKey].run_count = 1;
          context.stages[mapStageKey].runs.push({
            iteration: 1,
            started_at: runStartedAt,
            input: items[i] as Record<string, unknown>,
            status: 'running' as const,
          });
          execCtx.setContext(context);

          const result = await executeWithRetry(
            execCtx,
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

          const completedAt = new Date().toISOString();
          const run = context.stages[mapStageKey].runs[context.stages[mapStageKey].runs.length - 1];
          if (run) {
            run.status = 'completed';
            run.completed_at = completedAt;
            run.output = result.output as Record<string, unknown> | unknown[];
            const mapLogs = (result as any).logs as string | undefined;
            const mapStderr = (result as any).stderr as string | undefined;
            if (mapLogs) run.logs = mapLogs;
            if (mapStderr) run.stderr = mapStderr;
          }
          context.stages[mapStageKey].status = 'completed';
          context.stages[mapStageKey].latest = result.output as Record<string, unknown> | unknown[];
        } catch (err) {
          failureCount++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          const failedAt = new Date().toISOString();
          const run = context.stages[mapStageKey].runs[context.stages[mapStageKey].runs.length - 1];
          if (run) {
            run.status = 'failed';
            run.completed_at = failedAt;
            run.error = errorMsg;
          }
          context.stages[mapStageKey].status = 'failed';
          execCtx.setContext(context);

          if (failureCount > failureTolerance) {
            throw new TerminalError(
              `Stage "${stageId}" map failed: ${failureCount} failures exceeded tolerance of ${failureTolerance}. Last error: ${errorMsg}`,
            );
          }
          results[i] = { _error: errorMsg };
        }
      })());
    }
    await Promise.all(batchPromises);
  }

  context.stages[stageId].latest = results;
  context.stages[stageId].status = 'completed';
  execCtx.setContext(context);

  await routeDownstream(execCtx, stageId, results, definition, context);
}

// ---------------------------------------------------------------------------
// Step lifecycle (single execution with retry + error edges)
// ---------------------------------------------------------------------------

/**
 * Shared lifecycle wrapper for all step node executors.
 * Handles: iteration loop (for cycles), run entry management, retry with backoff,
 * error edge routing, context syncing, output validation, and edge evaluation/routing.
 */
export async function executeStepWithLifecycle(
  execCtx: ExecutionContext,
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

  // Cycle re-entry detection
  if (context.stages[stageId].run_count > 0) {
    const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
    if (cycleBehavior === 'continue') {
      input = {
        ...input,
        isCycleReentry: true,
        priorSessionId: `${execCtx.instanceId}:${stageId}`,
      };
    } else {
      input = {
        ...input,
        isCycleReentry: true,
      };
    }
  }

  let currentInput = input;

  while (true) {
    iteration++;

    if (iteration > maxIterations) {
      throw new TerminalError(`Max iterations (${maxIterations}) exceeded for stage "${stageId}"`);
    }

    // --- Start run ---
    const runStartedAt = new Date().toISOString();
    context.stages[stageId].status = 'running';
    context.stages[stageId].run_count = iteration;
    context.stages[stageId].runs.push({
      iteration,
      started_at: runStartedAt,
      input: (currentInput?.mergedInputs ?? currentInput?.sourceOutput) as Record<string, unknown> | undefined,
      status: 'running' as const,
    });
    execCtx.setContext(context);
    execCtx.setStatus('running');

    await syncContextToDb(execCtx, `sync-context-running-${stageId}-${iteration}`, context, {
      currentStageIds: [stageId],
    });

    // --- Execute the node (with retry) ---
    let output: unknown;
    let stageLogs: string | undefined;
    let stageStderr: string | undefined;
    try {
      const result = await executeWithRetry(
        execCtx,
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
      const failedAt = new Date().toISOString();
      const currentRunFail = context.stages[stageId].runs[context.stages[stageId].runs.length - 1];
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (currentRunFail) {
        currentRunFail.status = 'failed';
        currentRunFail.completed_at = failedAt;
        currentRunFail.error = errorMsg;
      }
      context.stages[stageId].status = 'failed';
      execCtx.setContext(context);

      await syncContextToDb(execCtx, `sync-context-fail-${stageId}-${iteration}`, context);

      // --- Error edge routing: check for on_error edges ---
      const errorEdgeTargets = evaluateEdges(
        stageId,
        { error: errorMsg, stageId },
        context,
        definition.edges,
        'on_error',
      );
      if (errorEdgeTargets.length > 0) {
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
        await executeStages(execCtx, errorEdgeTargets, definition, context, errorInputs);
        await propagateSkip(execCtx, stageId, definition, context);
        return;
      }

      throw new TerminalError(`Stage "${stageId}" failed: ${errorMsg}`);
    }

    // --- Complete run ---
    const outgoingEdges = definition.edges.filter((e) => e.source === stageId);

    const completedAt = new Date().toISOString();
    const currentRun = context.stages[stageId].runs[context.stages[stageId].runs.length - 1];
    if (currentRun) {
      currentRun.status = 'completed';
      currentRun.completed_at = completedAt;
      currentRun.output = output as Record<string, unknown> | unknown[];
      if (stageLogs) currentRun.logs = stageLogs;
      if (stageStderr) currentRun.stderr = stageStderr;
    }
    context.stages[stageId].latest = output as Record<string, unknown> | unknown[];
    context.stages[stageId].status = 'completed';
    execCtx.setContext(context);

    await syncContextToDb(execCtx, `sync-context-done-${stageId}-${iteration}`, context);

    // --- Edge evaluation and routing ---
    const nextStageIds = evaluateEdges(stageId, output, context, definition.edges, 'on_success');

    const successEdges = outgoingEdges.filter((e) => (e.trigger || 'on_success') === 'on_success');
    if (nextStageIds.length === 0 && successEdges.length > 0 && successEdges.some((e) => e.condition)) {
      await propagateSkip(execCtx, stageId, definition, context);
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
      const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
      currentInput = {
        ...nextInputs.get(stageId),
        isCycleReentry: true,
        ...(cycleBehavior === 'continue' ? { priorSessionId: `${execCtx.instanceId}:${stageId}` } : {}),
      };
      const otherStages = nextStageIds.filter((id) => id !== stageId);
      if (otherStages.length > 0) {
        await executeStages(execCtx, otherStages, definition, context, nextInputs);
      }
      continue;
    }

    if (nextStageIds.length > 0) {
      await executeStages(execCtx, nextStageIds, definition, context, nextInputs);
    }
    break;
  }

  // After the cycle exits: clean up lingering ACP sessions for 'continue' mode.
  const cycleBehavior = (config.cycle_behavior as string) || 'fresh';
  if (cycleBehavior === 'continue' && iteration > 1) {
    await fetch(`${appConfig.orchestratorUrl}/api/internal/kill-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: execCtx.instanceId, stageId }),
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Downstream routing helper
// ---------------------------------------------------------------------------

export async function routeDownstream(
  execCtx: ExecutionContext,
  stageId: string,
  output: unknown,
  definition: WorkflowDefinition,
  context: WorkflowContext,
): Promise<void> {
  const nextStageIds = evaluateEdges(stageId, output, context, definition.edges, 'on_success');
  const outgoingEdges = definition.edges.filter((e) => e.source === stageId);

  const successEdges = outgoingEdges.filter((e) => (e.trigger || 'on_success') === 'on_success');
  if (nextStageIds.length === 0 && successEdges.length > 0 && successEdges.some((e) => e.condition)) {
    await propagateSkip(execCtx, stageId, definition, context);
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
    await executeStages(execCtx, nextStageIds, definition, context, nextInputs);
  }
}
