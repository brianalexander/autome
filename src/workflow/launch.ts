import type { OrchestratorDB } from '../db/database.js';
import type { WorkflowDefinition } from '../schemas/pipeline.js';
import type { Event } from '../types/events.js';
import type { InitiatedBy } from '../types/instance.js';
import { startWorkflow as restateStart } from '../restate/client.js';
import { findEntryStages } from '../restate/pipeline-workflow.js';
import { broadcast } from '../api/websocket.js';
import { errorMessage } from '../utils/errors.js';
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
  /** Set when Restate failed to start the workflow */
  restateError?: string;
  /** Set when the trigger payload failed schema validation */
  validationError?: string;
}

/**
 * Create a workflow instance record, start it in Restate, handle Restate
 * errors, and broadcast the `instance:created` event.
 *
 * @param db          The orchestrator database
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
    restate_workflow_id: undefined,
  });

  let restateError: string | undefined;

  try {
    await restateStart(instance.id, workflow, event);
    db.updateInstance(instance.id, { restate_workflow_id: instance.id });
  } catch (err) {
    restateError = errorMessage(err);

    if (markEntryStagesOnError) {
      const entryStageIds = findEntryStages(workflow);
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
              error: `Failed to start workflow: ${restateError}`,
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

  return { instance, restateError };
}
