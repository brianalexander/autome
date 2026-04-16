import type { WorkflowDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import type { WorkflowContext } from '../types/instance.js';
import type { OrchestratorDB } from '../db/database.js';
import type { ExecutionContext } from './types.js';
import { TerminalError } from './types.js';
import { initializeContext, findEntryStages } from './graph-helpers.js';
import { executeStages } from './stage-executor.js';
import { nodeRegistry } from '../nodes/registry.js';

export interface PipelineStartOptions {
  seedContext?: WorkflowContext;
  entryStageIds?: string[];
}

/**
 * Main pipeline execution entry point.
 * Mirrors the `run` handler from src/restate/pipeline-workflow.ts but
 * uses ExecutionContext instead of restate.WorkflowContext.
 */
export async function runPipeline(
  execCtx: ExecutionContext,
  definition: WorkflowDefinition,
  triggerEvent: Event,
  options: PipelineStartOptions,
  db: OrchestratorDB,
): Promise<WorkflowContext> {
  const { seedContext, entryStageIds } = options;

  // Use the seed context if provided (resume path), otherwise initialize fresh
  const context: WorkflowContext = seedContext
    ? JSON.parse(JSON.stringify(seedContext))
    : initializeContext(triggerEvent, definition);

  // If resuming, reset the entry stages to pending so they re-execute cleanly
  if (seedContext && entryStageIds) {
    for (const stageId of entryStageIds) {
      if (context.stages[stageId]) {
        context.stages[stageId] = {
          ...context.stages[stageId],
          status: 'pending',
          // Keep run_count and runs for history
        };
      }
    }
  }

  execCtx.setStatus('running');
  execCtx.setContext(context);
  execCtx.setCurrentStageIds([]);

  // Find entry stages and execute the graph
  const entryStages = entryStageIds ?? findEntryStages(definition);

  if (entryStages.length === 0) {
    throw new TerminalError('Workflow has no entry stages (all stages have incoming edges)');
  }

  // Build initial inputs for entry stages
  const triggerStageIds = new Set(
    definition.stages.filter((s) => nodeRegistry.isTriggerType(s.type)).map((s) => s.id),
  );
  const entryInputs = new Map<string, import('../nodes/types.js').StageInput>();

  if (seedContext && entryStageIds) {
    // Resume path: build inputs from the completed upstream stages in the seed context
    for (const entryId of entryStages) {
      const incomingEdges = definition.edges.filter((e) => e.target === entryId);
      if (incomingEdges.length === 0) {
        continue;
      }
      if (incomingEdges.length === 1) {
        const edge = incomingEdges[0];
        const sourceOutput = context.stages[edge.source]?.latest;
        entryInputs.set(entryId, {
          incomingEdge: edge,
          sourceOutput,
        });
      } else {
        // Fan-in: collect all upstream outputs into mergedInputs
        const mergedInputs: Record<string, unknown> = {};
        for (const edge of incomingEdges) {
          const sourceStage = context.stages[edge.source];
          if (sourceStage?.status !== 'completed') {
            console.warn(
              `[pipeline] Resume fan-in: source stage '${edge.source}' is not completed (status: ${sourceStage?.status ?? 'unknown'}), skipping edge to '${entryId}'`,
            );
            continue;
          }
          mergedInputs[edge.source] = sourceStage.latest;
        }
        entryInputs.set(entryId, { mergedInputs });
      }
    }
  } else {
    // Normal (non-resume) path: pass trigger payload through trigger→entry edges
    for (const entryId of entryStages) {
      const triggerEdge = definition.edges.find((e) => triggerStageIds.has(e.source) && e.target === entryId);
      if (triggerEdge) {
        entryInputs.set(entryId, {
          incomingEdge: triggerEdge,
          sourceOutput: triggerEvent.payload,
        });
      }
    }
  }

  try {
    await executeStages(execCtx, entryStages, definition, context, entryInputs);

    execCtx.setStatus('completed');
    execCtx.setContext(context);

    // Sync final state to DB — execCtx.setContext already wrote it, but mark completed_at
    db.updateInstance(execCtx.instanceId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      context,
    });

    return context;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Mark any stages still "running" as "failed" with the error
    const errorTimestamp = new Date().toISOString();
    for (const [, sctx] of Object.entries(context.stages)) {
      if (sctx.status === 'running') {
        sctx.status = 'failed';
        const lastRun = sctx.runs[sctx.runs.length - 1];
        if (lastRun && lastRun.status === 'running') {
          lastRun.status = 'failed';
          lastRun.completed_at = errorTimestamp;
          lastRun.error = errorMsg;
        } else {
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

    execCtx.setStatus('failed');
    execCtx.setContext(context);

    db.updateInstance(execCtx.instanceId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      context,
    });

    throw err;
  }
}
