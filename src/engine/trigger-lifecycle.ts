/**
 * Manages trigger activation/deactivation lifecycle.
 * When a workflow is activated, starts any trigger executors (e.g., cron).
 * When deactivated, stops them.
 */
import { v4 as uuid } from 'uuid';
import { nodeRegistry } from '../nodes/registry.js';
import type { TriggerExecutor } from '../nodes/types.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { EventBus, EventSubscription } from '../events/bus.js';

/** Map of workflowId -> array of cleanup functions for active triggers */
const activeTriggers = new Map<string, Array<() => void>>();

/** Reference to the event bus, set via init() */
let eventBus: EventBus | null = null;

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

  const cleanups: Array<() => void> = [];

  for (const stage of definition.stages) {
    const spec = nodeRegistry.get(stage.type);
    if (!spec) continue;
    if (spec.category !== 'trigger') continue;

    const executor = spec.executor as TriggerExecutor;
    if (executor.type !== 'trigger' || !executor.activate) continue;

    const config = stage.config || spec.defaultConfig || {};

    try {
      const cleanup = await executor.activate(definition.id, stage.id, config, (payload: Record<string, unknown>) => {
        // Route trigger events through the event bus, matching the pattern
        // used by ManualTriggerProvider. The event bus will match this to
        // subscriptions and emit 'trigger' events that server.ts handles.
        eventBus!.handleEvent({
          id: uuid(),
          provider: stage.type,
          type: 'trigger',
          timestamp: new Date().toISOString(),
          payload,
        });
      });

      cleanups.push(cleanup);
      console.log(
        `[trigger-lifecycle] Activated trigger "${stage.type}" (stage ${stage.id}) for workflow ${definition.id}`,
      );
    } catch (err) {
      console.error(
        `[trigger-lifecycle] Failed to activate trigger "${stage.type}" (stage ${stage.id}) for workflow ${definition.id}:`,
        err,
      );
    }
  }

  if (cleanups.length > 0) {
    // Merge with any existing cleanups (shouldn't happen, but be safe)
    const existing = activeTriggers.get(definition.id) || [];
    activeTriggers.set(definition.id, [...existing, ...cleanups]);
  }
}

/**
 * Deactivate all trigger executors for a given workflow.
 * Calls each cleanup function returned by activate().
 */
export function deactivateWorkflowTriggers(workflowId: string): void {
  const cleanups = activeTriggers.get(workflowId);
  if (!cleanups || cleanups.length === 0) return;

  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[trigger-lifecycle] Error during cleanup for workflow ${workflowId}:`, err);
    }
  }

  activeTriggers.delete(workflowId);
  console.log(`[trigger-lifecycle] Deactivated all triggers for workflow ${workflowId}`);
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
