import type { OrchestratorDB } from '../db/database.js';
import type { AgentPool } from '../acp/pool.js';
import type { WorkflowInstance } from '../types/instance.js';
import type { WorkflowDefinition } from '../schemas/pipeline.js';
import { injectAuthorMessage } from '../author/message-injector.js';
import { broadcast } from '../api/websocket.js';

export interface TestRunListenerDeps {
  db: OrchestratorDB;
  authorPool: AgentPool;
  orchestratorPort: number;
}

/** Subscription handle returned by startTestRunListener. */
export type UnsubscribeFn = () => void;

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled']);

/**
 * Template a human-readable summary message for a finished test run.
 */
function templateMessage(instance: WorkflowInstance, status: TerminalStatus): string {
  const shortId = instance.id.slice(0, 8);

  if (status === 'completed') {
    const stageCount = Object.values(instance.context.stages).filter((s) => s.status === 'completed').length;
    return `Test run \`${shortId}\` completed successfully. All ${stageCount} stage${stageCount === 1 ? '' : 's'} passed.`;
  }

  if (status === 'cancelled') {
    return `Test run \`${shortId}\` was cancelled.`;
  }

  // status === 'failed'
  // Find the first failed stage in context.stages
  const failedEntry = Object.entries(instance.context.stages).find(([, s]) => s.status === 'failed');
  if (!failedEntry) {
    return `Test run \`${shortId}\` failed. Use \`get_test_run_stage_details\` for the full transcript.`;
  }

  const [failedStageId, failedStage] = failedEntry;
  const lastRun = failedStage.runs[failedStage.runs.length - 1];
  const rawError = lastRun?.error ?? 'unknown error';
  const errorExcerpt = rawError.length > 200 ? rawError.slice(0, 200) + '…' : rawError;
  const iteration = lastRun?.iteration ?? failedStage.run_count;

  return (
    `Test run \`${shortId}\` failed at stage \`${failedStageId}\` (iteration ${iteration}): ${errorExcerpt}. ` +
    `Use \`get_test_run_stage_details\` for the full transcript.`
  );
}

/**
 * Subscribe to workflow lifecycle events.  When an author-initiated instance
 * reaches terminal state, template a summary and inject it into the author's
 * ACP session for the parent workflow.
 *
 * Hooks into the module-level event emitter that workflow-finished notifies,
 * so no HTTP polling is needed.
 *
 * Returns an unsubscribe function for graceful shutdown.
 */
export function startTestRunListener(deps: TestRunListenerDeps): UnsubscribeFn {
  // Per-listener dedup set. Cleared when it exceeds 10 000 entries — test runs
  // are short-lived and the janitor removes them, so re-injecting after the
  // cap is hit has no correctness impact.
  const injectedInstances = new Set<string>();

  async function handleFinished(instanceId: string, status: string): Promise<void> {
    if (!TERMINAL_STATUSES.has(status)) return;

    if (injectedInstances.has(instanceId)) return;
    if (injectedInstances.size >= 10_000) injectedInstances.clear();
    injectedInstances.add(instanceId);

    const instance = deps.db.getInstance(instanceId);
    if (!instance) return;

    // Only act on author-initiated test runs
    if (instance.initiated_by !== 'author') return;

    const terminalStatus = status as TerminalStatus;

    // Look up the test workflow for this instance
    if (!instance.definition_id) return;
    const testWorkflow = deps.db.getWorkflow(instance.definition_id);
    if (!testWorkflow) {
      console.warn(`[test-run-listener] Test workflow ${instance.definition_id} not found for instance ${instanceId}`);
      return;
    }

    // Require a parent workflow
    const parentWorkflowId = (testWorkflow as WorkflowDefinition).parent_workflow_id;
    if (!parentWorkflowId) {
      console.warn(
        `[test-run-listener] Instance ${instanceId} has initiated_by='author' but test workflow ` +
          `${testWorkflow.id} has no parent_workflow_id — skipping`,
      );
      return;
    }

    // The parent may be an unsaved draft (id like `draft-...`) which has no
    // workflows row. That's fine — the author session is keyed by the parent
    // id directly, so injection still works. Look up the parent only to get
    // its name for the toast, falling back to the test workflow's stripped name.
    const parentWorkflow = deps.db.getWorkflow(parentWorkflowId);
    const parentWorkflowName =
      parentWorkflow?.name ?? testWorkflow.name.replace(/^\[Test\]\s*/, '') ?? parentWorkflowId;

    const message = templateMessage(instance, terminalStatus);

    const result = await injectAuthorMessage({ db: deps.db, authorPool: deps.authorPool, orchestratorPort: deps.orchestratorPort }, parentWorkflowId, message, {
      kind: 'system',
    });

    console.log(
      `[test-run-listener] Instance ${instanceId} (${terminalStatus}) → parent ${parentWorkflowId}` +
        (parentWorkflow ? '' : ' (draft)') +
        `: delivered=${result.delivered} buffered=${result.buffered}`,
    );

    // Find failed stage id for the WS toast event
    const failedStageId =
      terminalStatus === 'failed'
        ? Object.entries(instance.context.stages).find(([, s]) => s.status === 'failed')?.[0]
        : undefined;

    // Broadcast global (unscoped) toast event for the frontend notification bar
    broadcast(
      'author:test_run_completed',
      {
        parentWorkflowId,
        parentWorkflowName,
        instanceId,
        status: terminalStatus,
        ...(failedStageId ? { failedStageId } : {}),
      },
      undefined,
    );
  }

  // Register with the module-level emitter
  workflowFinishedEmitter.on('finished', handleFinished);

  return () => {
    workflowFinishedEmitter.off('finished', handleFinished);
  };
}

// ---------------------------------------------------------------------------
// Module-level event emitter — workflow-finished endpoint calls notifyWorkflowFinished
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';

/** Internal emitter so workflow-finished can notify the listener without HTTP coupling. */
const workflowFinishedEmitter = new EventEmitter();
workflowFinishedEmitter.setMaxListeners(20);

/**
 * Called by POST /api/internal/workflow-finished after persisting the status.
 * This keeps the listener decoupled from the HTTP layer.
 */
export function notifyWorkflowFinished(instanceId: string, status: string): void {
  workflowFinishedEmitter.emit('finished', instanceId, status);
}
