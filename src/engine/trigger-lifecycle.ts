/**
 * Manages trigger activation/deactivation lifecycle.
 * When a workflow is activated, starts any trigger executors (e.g., cron).
 * When deactivated, stops them.
 *
 * Phase 4: Tracks per-trigger runtime status + logs for observability.
 */
import { v4 as uuid } from 'uuid';
import { nodeRegistry } from '../nodes/registry.js';
import type { TriggerExecutor, TriggerActivateContext, TriggerLogger } from '../nodes/types.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { EventBus, EventSubscription } from '../events/bus.js';
import { getSecretsSnapshot } from '../secrets/service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriggerStatus {
  state: 'starting' | 'active' | 'errored' | 'stopped';
  startedAt: string;
  lastEventAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  eventCount: number;
  errorCount: number;
}

type TriggerCleanup = () => void;

interface TriggerRuntime {
  workflowId: string;
  stageId: string;
  stageType: string;
  cleanup: TriggerCleanup;
  status: TriggerStatus;
  logs: string[];
}

const LOG_BUFFER_MAX = 200;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Map of workflowId -> Map<stageId, TriggerRuntime> */
const activeTriggers = new Map<string, Map<string, TriggerRuntime>>();

/** Reference to the event bus, set via init() */
let eventBus: EventBus | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getRuntime(workflowId: string, stageId: string): TriggerRuntime | undefined {
  return activeTriggers.get(workflowId)?.get(stageId);
}

function appendLog(workflowId: string, stageId: string, line: string): void {
  const rt = getRuntime(workflowId, stageId);
  if (!rt) return;
  rt.logs.push(line);
  if (rt.logs.length > LOG_BUFFER_MAX) {
    rt.logs.shift();
  }
}

function setState(workflowId: string, stageId: string, state: TriggerStatus['state']): void {
  const rt = getRuntime(workflowId, stageId);
  if (!rt) return;
  rt.status.state = state;
}

function recordEvent(workflowId: string, stageId: string): void {
  const rt = getRuntime(workflowId, stageId);
  if (!rt) return;
  rt.status.eventCount += 1;
  rt.status.lastEventAt = new Date().toISOString();
  if (rt.status.state !== 'errored') {
    rt.status.state = 'active';
  }
}

function recordError(workflowId: string, stageId: string, err: Error | string): void {
  const rt = getRuntime(workflowId, stageId);
  if (!rt) return;
  const msg = typeof err === 'string' ? err : err.message;
  rt.status.errorCount += 1;
  rt.status.lastErrorAt = new Date().toISOString();
  rt.status.lastError = msg;
  rt.status.state = 'errored';
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

function formatLogLine(level: 'INFO' | 'WARN' | 'ERROR', msg: string): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `[${ts}] [${level}] ${msg}`;
}

export function makeLogger(workflowId: string, stageId: string, stageType: string): TriggerLogger {
  const prefix = `[trigger:${stageType}:${workflowId}/${stageId}]`;
  return {
    info(msg: string): void {
      const line = formatLogLine('INFO', msg);
      appendLog(workflowId, stageId, line);
      console.log(`${prefix} ${msg}`);
    },
    warn(msg: string): void {
      const line = formatLogLine('WARN', msg);
      appendLog(workflowId, stageId, line);
      console.warn(`${prefix} ${msg}`);
    },
    error(msg: string, err?: Error): void {
      const fullMsg = err ? `${msg}: ${err.message}` : msg;
      const line = formatLogLine('ERROR', fullMsg);
      appendLog(workflowId, stageId, line);
      console.error(`${prefix} ${fullMsg}`);
      recordError(workflowId, stageId, fullMsg);
    },
  };
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

export function getWorkflowTriggerStatuses(
  workflowId: string,
): Record<string, TriggerStatus & { logsPreview: string[] }> {
  const stageMap = activeTriggers.get(workflowId);
  if (!stageMap) return {};
  const result: Record<string, TriggerStatus & { logsPreview: string[] }> = {};
  for (const [stageId, rt] of stageMap) {
    result[stageId] = {
      ...rt.status,
      logsPreview: rt.logs.slice(-10),
    };
  }
  return result;
}

export function getTriggerLogs(workflowId: string, stageId: string, limit = 200): string[] {
  const rt = getRuntime(workflowId, stageId);
  if (!rt) return [];
  return rt.logs.slice(-limit);
}

// ---------------------------------------------------------------------------
// Subscription helpers (unchanged from original)
// ---------------------------------------------------------------------------

/**
 * Initialize the trigger lifecycle manager with a reference to the event bus.
 * Must be called before activateWorkflowTriggers.
 */
export function initTriggerLifecycle(bus: EventBus): void {
  eventBus = bus;
}

/**
 * Build and register EventBus subscriptions for a workflow's trigger stages.
 * Handles both the multi-stage path (one sub per trigger stage) and the
 * legacy fallback path (single sub keyed on the top-level trigger.provider).
 *
 * Called both during server startup (restoring active workflows) and from
 * the activate route handler.
 */
export function createTriggerSubscriptions(
  workflow: WorkflowDefinition,
  bus: EventBus,
): void {
  const triggerStages = (workflow.stages || []).filter(
    (s: { type: string }) => nodeRegistry.isTriggerType(s.type),
  );

  if (triggerStages.length === 0) {
    // Fallback: use legacy top-level trigger.provider for backwards compat
    const sub: EventSubscription = {
      id: `sub-${workflow.id}`,
      provider: workflow.trigger.provider,
      eventType: 'trigger',
      filter: workflow.trigger.filter,
      workflowDefinitionId: workflow.id,
    };
    bus.addSubscription(sub);
  } else {
    for (const stage of triggerStages) {
      const sub: EventSubscription = {
        id: `sub-${workflow.id}-${stage.id}`,
        provider: stage.type,
        eventType: 'trigger',
        filter: workflow.trigger.filter,
        workflowDefinitionId: workflow.id,
      };
      bus.addSubscription(sub);
    }
  }
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

/**
 * Activate trigger executors for a workflow definition.
 * Finds all trigger-category stages that have a TriggerExecutor with an activate() method,
 * and calls activate() on each. The emit callback routes events through the event bus
 * so they are handled the same way as manual triggers.
 */
export async function activateWorkflowTriggers(definition: WorkflowDefinition): Promise<void> {
  if (!eventBus) {
    console.error('[trigger-lifecycle] Event bus not initialized. Call initTriggerLifecycle() first.');
    return;
  }

  // Ensure we have a stage map for this workflow
  if (!activeTriggers.has(definition.id)) {
    activeTriggers.set(definition.id, new Map());
  }
  const stageMap = activeTriggers.get(definition.id)!;

  for (const stage of definition.stages) {
    const spec = nodeRegistry.get(stage.type);
    if (!spec) continue;
    if (spec.category !== 'trigger') continue;

    const executor = spec.executor as TriggerExecutor;
    if (executor.type !== 'trigger' || !executor.activate) continue;

    const stageConfig = stage.config || spec.defaultConfig || {};
    const configWithVersion = { ...stageConfig, _workflowVersion: definition.version ?? 1 };

    // Register the runtime entry with 'starting' state before calling activate
    const now = new Date().toISOString();
    const runtime: TriggerRuntime = {
      workflowId: definition.id,
      stageId: stage.id,
      stageType: stage.type,
      cleanup: () => {},
      status: {
        state: 'starting',
        startedAt: now,
        lastEventAt: null,
        lastErrorAt: null,
        lastError: null,
        eventCount: 0,
        errorCount: 0,
      },
      logs: [],
    };
    stageMap.set(stage.id, runtime);

    const logger = makeLogger(definition.id, stage.id, stage.type);

    try {
      const ctx: TriggerActivateContext = {
        workflowId: definition.id,
        stageId: stage.id,
        config: configWithVersion,
        emit: (payload: Record<string, unknown>) => {
          // Route trigger events through the event bus, matching the pattern
          // used by ManualTriggerProvider. The event bus will match this to
          // subscriptions and emit 'trigger' events that server.ts handles.
          try {
            eventBus!.handleEvent({
              id: uuid(),
              provider: stage.type,
              type: 'trigger',
              timestamp: new Date().toISOString(),
              payload,
            });
            recordEvent(definition.id, stage.id);
          } catch (emitErr) {
            recordError(definition.id, stage.id, emitErr instanceof Error ? emitErr : new Error(String(emitErr)));
          }
        },
        secrets: getSecretsSnapshot(),
        logger,
      };

      const cleanup = await executor.activate(ctx);

      runtime.cleanup = cleanup;
      // Only move to 'active' if no errors were recorded during activation
      if (runtime.status.state !== 'errored') {
        setState(definition.id, stage.id, 'active');
      }
      logger.info(`Activated trigger "${stage.type}" (stage ${stage.id}) for workflow ${definition.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to activate trigger "${stage.type}" (stage ${stage.id}) for workflow ${definition.id}`, err instanceof Error ? err : new Error(msg));
    }
  }
}

/**
 * Deactivate all trigger executors for a given workflow.
 * Calls each cleanup function returned by activate().
 */
export function deactivateWorkflowTriggers(workflowId: string): void {
  const stageMap = activeTriggers.get(workflowId);
  if (!stageMap || stageMap.size === 0) return;

  for (const [stageId, rt] of stageMap) {
    try {
      rt.cleanup();
      rt.status.state = 'stopped';
    } catch (err) {
      console.error(`[trigger-lifecycle] Error during cleanup for workflow ${workflowId} stage ${stageId}:`, err);
    }
  }

  activeTriggers.delete(workflowId);
  console.log(`[trigger-lifecycle] Deactivated all triggers for workflow ${workflowId}`);
}

/**
 * Reset all module-level state. For use in tests only.
 * Clears the activeTriggers map and the eventBus reference without
 * invoking cleanup callbacks (tests manage their own teardown).
 */
export function resetForTesting(): void {
  activeTriggers.clear();
  eventBus = null;
}

/**
 * Deactivate all active triggers across all workflows.
 * Called during graceful server shutdown.
 */
export function deactivateAll(): void {
  for (const workflowId of activeTriggers.keys()) {
    deactivateWorkflowTriggers(workflowId);
  }
  console.log('[trigger-lifecycle] All triggers deactivated');
}
