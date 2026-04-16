import type { OrchestratorDB } from '../db/database.js';
import type { WorkflowDefinition } from '../schemas/pipeline.js';
import type { Event } from '../types/events.js';
import type { InitiatedBy, WorkflowInstance, WorkflowContext } from '../types/instance.js';
import type { WorkflowRunner } from '../engine/runner.js';
import { broadcast } from '../api/websocket.js';
import { nodeRegistry } from '../nodes/registry.js';
import { jsonSchemaToZod } from '../nodes/schema-to-zod.js';

interface LaunchOptions {
  isTest?: boolean;
  /**
   * Who initiated this workflow run. Defaults to 'user'.
   * Use 'author' for AI Author test runs, 'webhook' for webhook triggers,
   * 'cron' for scheduled runs.
   */
  initiatedBy?: InitiatedBy;
  /**
   * When true, mark entry stages as failed with a detailed run record.
   * When false (e.g. webhook), only update instance status to failed.
   * Defaults to true.
   */
  markEntryStagesOnError?: boolean;
}

export interface LaunchResult {
  instance?: ReturnType<OrchestratorDB['createInstance']>;
  /** Set when the runner failed to start the workflow */
  runnerError?: string;
  /** Set when the trigger payload failed schema validation */
  validationError?: string;
}

/**
 * Create a workflow instance record, start it via WorkflowRunner, handle
 * errors, and broadcast the `instance:created` event.
 *
 * @param db          The orchestrator database
 * @param runner      The WorkflowRunner instance
 * @param workflow    The workflow definition to launch
 * @param event       The trigger event that caused the launch
 * @param stageIds    The stage IDs to include in the instance context
 *                    (pass pre-filtered list, e.g. excluding trigger stages)
 * @param definitionId The definition ID to use for the broadcast (may differ
 *                    from workflow.id for test runs using a temp definition)
 * @param opts        Optional flags
 */
export async function launchWorkflow(
  db: OrchestratorDB,
  runner: WorkflowRunner,
  workflow: WorkflowDefinition,
  event: Event,
  stageIds: string[],
  definitionId: string,
  opts?: LaunchOptions,
): Promise<LaunchResult> {
  const { isTest = false, initiatedBy = 'user', markEntryStagesOnError = true } = opts ?? {};

  // Validate trigger payload against the trigger stage's payload_schema (if configured)
  const triggerStage = workflow.stages.find(s => nodeRegistry.isTriggerType(s.type));
  const payloadSchema = (triggerStage?.config as Record<string, unknown> | undefined)?.payload_schema;
  if (payloadSchema && typeof payloadSchema === 'object') {
    try {
      const zodSchema = jsonSchemaToZod(payloadSchema as Record<string, unknown>);
      const validation = zodSchema.safeParse(event.payload);
      if (!validation.success) {
        const issues = validation.error.issues
          .map(i => `${i.path.map(String).join('.')}: ${i.message}`)
          .join('; ');
        return { validationError: issues };
      }
    } catch (err) {
      console.warn('[launch] Payload schema validation error:', err);
      // Don't block launch if schema conversion itself fails
    }
  }

  // Find all trigger stages — they don't execute as workflow steps but should
  // appear in context as already-completed so the canvas and timeline show them.
  const triggerStageIds = workflow.stages
    .filter((s) => nodeRegistry.isTriggerType(s.type))
    .map((s) => s.id);

  const triggerTimestamp = new Date().toISOString();

  const context = {
    trigger: (event.payload ?? {}) as Record<string, unknown>,
    stages: {
      // Trigger stages — mark as completed with the event payload as their output
      ...Object.fromEntries(
        triggerStageIds.map((id) => [
          id,
          {
            status: 'completed' as const,
            run_count: 1,
            runs: [
              {
                iteration: 1,
                started_at: triggerTimestamp,
                completed_at: triggerTimestamp,
                status: 'completed' as const,
                output: event.payload as Record<string, unknown> | unknown[],
              },
            ],
            latest: event.payload as Record<string, unknown> | unknown[],
          },
        ]),
      ),
      // Non-trigger stages — pending
      ...Object.fromEntries(
        stageIds.map((id) => [id, { status: 'pending' as const, run_count: 0, runs: [] }]),
      ),
    },
  };

  const instance = db.createInstance({
    definition_id: workflow.id,
    definition_version: workflow.version,
    is_test: isTest || undefined,
    initiated_by: initiatedBy,
    resume_count: 0,
    status: 'running',
    trigger_event: event as unknown as Record<string, unknown>,
    context,
    current_stage_ids: [],
  });

  let runnerError: string | undefined;

  try {
    await runner.start(instance.id, workflow, event);
  } catch (err) {
    runnerError = err instanceof Error ? err.message : String(err);

    if (markEntryStagesOnError) {
      // Find entry stage IDs: non-trigger stages with no incoming edges
      const targetIds = new Set(workflow.edges.map(e => e.target));
      const entryStageIds = workflow.stages
        .filter(s => !nodeRegistry.isTriggerType(s.type) && !targetIds.has(s.id))
        .map(s => s.id);

      const updatedContext = { ...instance.context };
      for (const stageId of entryStageIds) {
        if (updatedContext.stages[stageId]) {
          updatedContext.stages[stageId].status = 'failed';
          updatedContext.stages[stageId].runs = [
            {
              iteration: 1,
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              status: 'failed',
              error: `Failed to start workflow: ${runnerError}`,
            },
          ];
        }
      }
      db.updateInstance(instance.id, { status: 'failed', context: updatedContext });
    } else {
      db.updateInstance(instance.id, { status: 'failed' });
    }
  }

  broadcast(
    'instance:created',
    {
      instanceId: instance.id,
      definitionId,
      triggerEvent: event,
    },
    { workflowId: definitionId },
  );

  return { instance, runnerError };
}

export interface ResumeResult {
  resumeCount: number;
  runnerError?: string;
}

/**
 * Resume a failed or cancelled workflow instance from the given entry stages.
 */
export async function launchWorkflowWithResume(
  db: OrchestratorDB,
  runner: WorkflowRunner,
  instance: WorkflowInstance,
  definition: WorkflowDefinition,
  fromStageIds: string[],
): Promise<ResumeResult> {
  // Build seed context: deep-clone the current context, then reset stages that
  // need to re-execute (the entry stages and everything reachable from them).
  const seedContext: WorkflowContext = JSON.parse(JSON.stringify(instance.context));

  // BFS from fromStageIds to find all downstream stages that must be reset.
  const stagesToReset = new Set<string>();
  const visited = new Set<string>(fromStageIds);
  const queue = [...fromStageIds];

  // Entry stages are always reset regardless of status.
  for (const id of fromStageIds) {
    stagesToReset.add(id);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of definition.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
        // Only reset stages that are not already completed
        if (seedContext.stages[edge.target]?.status !== 'completed') {
          stagesToReset.add(edge.target);
        }
      }
    }
  }

  // Determine which edges touch reset stages (source OR target is being reset)
  const edgesToClear = new Set<string>();
  for (const edge of definition.edges) {
    if (stagesToReset.has(edge.source) || stagesToReset.has(edge.target)) {
      edgesToClear.add(edge.id);
    }
  }

  // Reset each stage: keep run_count and runs for history, clear status to pending.
  for (const stageId of stagesToReset) {
    if (seedContext.stages[stageId]) {
      seedContext.stages[stageId] = {
        ...seedContext.stages[stageId],
        status: 'pending',
        // run_count and runs are intentionally kept for history
      };
    }
  }

  // Clear edgeTraversals for edges that touch reset stages
  if (seedContext.edgeTraversals) {
    for (const edgeId of edgesToClear) {
      delete seedContext.edgeTraversals[edgeId];
    }
  }

  // Clear fanInCompletions for stages that are being reset
  if (seedContext.fanInCompletions) {
    for (const stageId of stagesToReset) {
      delete seedContext.fanInCompletions[stageId];
    }
  }

  // Clear pendingInputs for stages that are being reset
  if (seedContext.pendingInputs) {
    for (const stageId of stagesToReset) {
      delete seedContext.pendingInputs[stageId];
    }
  }

  const resumeCount = (instance.resume_count ?? 0) + 1;

  let runnerError: string | undefined;
  try {
    await runner.startResume(
      instance.id,
      definition,
      instance.trigger_event as unknown as Event,
      seedContext,
      fromStageIds,
    );
  } catch (err) {
    runnerError = err instanceof Error ? err.message : String(err);
  }

  if (runnerError) {
    return { runnerError, resumeCount };
  }

  // Update the DB instance to reflect the new run
  db.updateInstance(instance.id, {
    resume_count: resumeCount,
    status: 'running',
    context: seedContext,
    completed_at: undefined,
  });

  broadcast(
    'instance:resumed',
    { instanceId: instance.id, resumeCount, fromStageIds },
    { instanceId: instance.id },
  );

  return { resumeCount };
}
