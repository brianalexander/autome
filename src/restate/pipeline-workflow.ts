import * as restate from '@restatedev/restate-sdk';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import type { WorkflowContext } from '../types/instance.js';
import { config as appConfig } from '../config.js';
import { initializeContext, findEntryStages } from './graph-helpers.js';
import { executeStages } from './stage-executor.js';
import { nodeRegistry } from '../nodes/registry.js';

// Re-export WorkflowContext for existing consumers
export type { WorkflowContext };

// Re-export graph helpers used by external modules (launch.ts, tests)
export { initializeContext, findEntryStages, isTerminalStage, evaluateEdges } from './graph-helpers.js';

/** Output from any stage executor — the workflow doesn't know the specific shape */
type StageOutput = Record<string, unknown>;

// Types for workflow input/state
export interface WorkflowInput {
  definition: WorkflowDefinition;
  triggerEvent: Event;
  /** If present, use this context directly instead of calling initializeContext() */
  seedContext?: WorkflowContext;
  /** If present, use these stage IDs as entry points instead of calling findEntryStages() */
  entryStageIds?: string[];
}

export interface WorkflowState {
  status: string;
  context: WorkflowContext;
  currentStageIds: string[];
}

// The workflow definition
export const pipelineWorkflow = restate.workflow({
  name: 'pipeline',
  handlers: {
    // Main run handler — executes exactly once per workflow ID
    run: async (ctx: restate.WorkflowContext, input: WorkflowInput): Promise<WorkflowContext> => {
      const { definition, triggerEvent, seedContext, entryStageIds } = input;
      const orchestratorUrl = appConfig.orchestratorUrl;

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
              // Keep run_count and runs for history; they were preserved by launchWorkflowWithResume
            };
          }
        }
      }

      ctx.set('status', 'running');
      ctx.set('context', context);
      ctx.set('currentStageIds', [] as string[]);

      // Find entry stages and execute the graph
      const entryStages = entryStageIds ?? findEntryStages(definition);

      if (entryStages.length === 0) {
        throw new restate.TerminalError('Workflow has no entry stages (all stages have incoming edges)');
      }

      // Build initial inputs for entry stages
      const triggerStageIds = new Set(definition.stages.filter((s) => nodeRegistry.isTriggerType(s.type)).map((s) => s.id));
      const entryInputs = new Map<string, import('../nodes/types.js').StageInput>();

      if (seedContext && entryStageIds) {
        // Resume path: build inputs from the completed upstream stages in the seed context.
        // For each entry stage, collect all incoming edges and look up the source's latest output.
        for (const entryId of entryStages) {
          const incomingEdges = definition.edges.filter((e) => e.target === entryId);
          if (incomingEdges.length === 0) {
            // No upstream — entry stage with no edges, no input to pass
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
            // Fan-in: collect all upstream outputs into mergedInputs.
            // Skip source stages that are not yet completed (e.g. reset in a diamond topology).
            const mergedInputs: Record<string, unknown> = {};
            for (const edge of incomingEdges) {
              const sourceStage = context.stages[edge.source];
              if (sourceStage?.status !== 'completed') {
                console.warn(
                  `[pipeline-workflow] Resume fan-in: source stage '${edge.source}' is not completed (status: ${sourceStage?.status ?? 'unknown'}), skipping edge to '${entryId}'`,
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
        await executeStages(ctx, entryStages, definition, context, entryInputs);

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

    getStatus: async (ctx: restate.WorkflowSharedContext): Promise<WorkflowState> => {
      return {
        status: (await ctx.get<string>('status')) || 'unknown',
        context: (await ctx.get<WorkflowContext>('context')) || { trigger: {}, stages: {} },
        currentStageIds: (await ctx.get<string[]>('currentStageIds')) || [],
      };
    },

  },
});
