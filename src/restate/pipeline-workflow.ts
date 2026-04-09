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
interface WorkflowInput {
  definition: WorkflowDefinition;
  triggerEvent: Event;
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

      // Build initial inputs for entry stages — pass trigger output through the trigger→entry edges
      const triggerStageIds = new Set(definition.stages.filter((s) => nodeRegistry.isTriggerType(s.type)).map((s) => s.id));
      const entryInputs = new Map<string, import('../nodes/types.js').StageInput>();
      for (const entryId of entryStages) {
        // Find the trigger edge that points to this entry stage
        const triggerEdge = definition.edges.find((e) => triggerStageIds.has(e.source) && e.target === entryId);
        if (triggerEdge) {
          entryInputs.set(entryId, {
            incomingEdge: triggerEdge,
            sourceOutput: triggerEvent.payload,
          });
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
