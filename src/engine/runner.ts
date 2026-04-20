import { randomUUID } from 'crypto';
import type { OrchestratorDB } from '../db/database.js';
import type { EventBus } from '../events/bus.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { Event } from '../types/events.js';
import type { WorkflowContext } from '../types/instance.js';
import type { ExecutionContext } from './types.js';
import { TerminalError, isTerminalError } from './types.js';
import { broadcast } from '../api/websocket.js';

interface RunHandle {
  instanceId: string;
  abortController: AbortController;
  executionPromise: Promise<void>;
  waitResolvers: Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
}

interface StartOptions {
  seedContext?: WorkflowContext;
  entryStageIds?: string[];
}

export class WorkflowRunner {
  private active = new Map<string, RunHandle>();

  constructor(
    private db: OrchestratorDB,
    private eventBus: EventBus,
    private orchestratorUrl: string = 'http://127.0.0.1:3001',
  ) {}

  async start(
    instanceId: string,
    definition: WorkflowDefinition,
    triggerEvent: Event,
    options: StartOptions = {},
  ): Promise<void> {
    if (this.active.has(instanceId)) {
      throw new Error(`Workflow instance ${instanceId} is already running`);
    }

    const abortController = new AbortController();
    const waitResolvers = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

    // Build the ExecutionContext for this run
    const execCtx: ExecutionContext = {
      instanceId,
      orchestratorUrl: this.orchestratorUrl,
      setStatus: (status) => {
        this.db.updateInstance(instanceId, { status: status as import('../types/instance.js').WorkflowInstance['status'] });
        this.eventBus.emit('instance:status', { instanceId, status });
        broadcast('instance:updated', { instanceId, status }, { instanceId });
      },
      setContext: (context) => {
        this.db.updateInstance(instanceId, { context });
        broadcast('instance:updated', { instanceId }, { instanceId });
      },
      setCurrentStageIds: (ids) => {
        this.db.updateInstance(instanceId, { current_stage_ids: ids });
        broadcast('instance:updated', { instanceId, currentStageIds: ids }, { instanceId });
      },
      waitFor: <T = unknown>(key: string): Promise<T> => {
        return this.waitForSignal<T>(instanceId, key, waitResolvers);
      },
      sleep: (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
      abortSignal: abortController.signal,
    };

    // Run the pipeline in the background
    const executionPromise = (async () => {
      try {
        // Import lazily to avoid circular deps
        const { runPipeline } = await import('./pipeline.js');
        await runPipeline(execCtx, definition, triggerEvent, options, this.db);
      } catch (err) {
        if (abortController.signal.aborted) {
          this.db.updateInstance(instanceId, { status: 'cancelled', completed_at: new Date().toISOString() });
          broadcast('instance:updated', { instanceId, status: 'cancelled' }, { instanceId });
        } else {
          console.error(`[runner] Workflow ${instanceId} failed:`, err);
          this.db.updateInstance(instanceId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
          });
          broadcast('instance:updated', { instanceId, status: 'failed' }, { instanceId });
        }
        throw err;
      } finally {
        this.active.delete(instanceId);
        // Reject any still-pending waits
        for (const [, resolver] of waitResolvers) {
          resolver.reject(new Error('Instance execution ended'));
        }
      }
    })();

    // Swallow unhandled rejections (they're logged above)
    executionPromise.catch(() => {});

    this.active.set(instanceId, {
      instanceId,
      abortController,
      executionPromise,
      waitResolvers,
    });
  }

  async startResume(
    instanceId: string,
    definition: WorkflowDefinition,
    triggerEvent: Event,
    seedContext: WorkflowContext,
    entryStageIds: string[],
  ): Promise<void> {
    return this.start(instanceId, definition, triggerEvent, { seedContext, entryStageIds });
  }

  async cancel(instanceId: string): Promise<void> {
    const handle = this.active.get(instanceId);
    if (!handle) {
      // Not running in memory — just update DB
      this.db.updateInstance(instanceId, { status: 'cancelled', completed_at: new Date().toISOString() });
      broadcast('instance:updated', { instanceId, status: 'cancelled' }, { instanceId });
      return;
    }
    console.log(`[runner.cancel] ${instanceId}: aborting, ${handle.waitResolvers.size} waiters pending`);
    handle.abortController.abort();
    // Reject all waiting resolvers
    for (const [key, resolver] of handle.waitResolvers) {
      console.log(`[runner.cancel] ${instanceId}: rejecting waiter "${key}"`);
      resolver.reject(new Error('Cancelled'));
    }
    // Wait for the execution promise to settle, but don't hang forever if it gets stuck.
    // If it doesn't settle in 5 seconds, force DB update + remove from active map.
    const timeoutMs = 5000;
    const settled = await Promise.race([
      handle.executionPromise.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!settled) {
      console.warn(
        `[runner.cancel] ${instanceId}: executionPromise did not settle within ${timeoutMs}ms — forcing cancellation`,
      );
      this.db.updateInstance(instanceId, { status: 'cancelled', completed_at: new Date().toISOString() });
      broadcast('instance:updated', { instanceId, status: 'cancelled' }, { instanceId });
      this.active.delete(instanceId);
    } else {
      console.log(`[runner.cancel] ${instanceId}: execution settled`);
    }
  }

  /** Resolves a durable wait for the given instance+key. Returns true if a waiter was found. */
  resolveWait(instanceId: string, key: string, value: unknown): boolean {
    // Persist to DB first (survives process restart)
    const [kind, stageId] = this.parseWaitKey(key);
    if (kind && stageId) {
      this.db.resolveGate(instanceId, stageId, kind, value);
    }
    // Then fire in-memory resolver if active
    const handle = this.active.get(instanceId);
    if (!handle) return false;
    const resolver = handle.waitResolvers.get(key);
    if (!resolver) return false;
    resolver.resolve(value);
    handle.waitResolvers.delete(key);
    return true;
  }

  rejectWait(instanceId: string, key: string, reason: unknown): boolean {
    const [kind, stageId] = this.parseWaitKey(key);
    if (kind && stageId) {
      this.db.rejectGate(instanceId, stageId, kind, reason);
    }
    const handle = this.active.get(instanceId);
    if (!handle) return false;
    const resolver = handle.waitResolvers.get(key);
    if (!resolver) return false;
    resolver.reject(reason instanceof Error ? reason : new Error(String(reason)));
    handle.waitResolvers.delete(key);
    return true;
  }

  /** Parses "gate-<stageId>" or "stage-complete-<stageId>" into (kind, stageId). */
  private parseWaitKey(key: string): [kind: 'gate' | 'stage-complete' | null, stageId: string | null] {
    if (key.startsWith('stage-complete-')) return ['stage-complete', key.slice('stage-complete-'.length)];
    if (key.startsWith('gate-')) return ['gate', key.slice('gate-'.length)];
    return [null, null];
  }

  private async waitForSignal<T>(
    instanceId: string,
    key: string,
    waitResolvers: Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  ): Promise<T> {
    const [kind, stageId] = this.parseWaitKey(key);
    if (!kind || !stageId) {
      throw new Error(`Invalid wait key: ${key}. Expected 'gate-<stageId>' or 'stage-complete-<stageId>'`);
    }

    // Check if already resolved from a previous run (recovery case)
    const existing = this.db.getGate(instanceId, stageId, kind);
    if (existing?.status === 'resolved') {
      return existing.payload as T;
    }
    if (existing?.status === 'rejected') {
      throw existing.payload instanceof Error ? existing.payload : new Error(String(existing.payload));
    }

    // Persist the waiting marker
    this.db.upsertWaitingGate(instanceId, stageId, kind);

    // Register in-memory resolver and return its promise
    return new Promise<T>((resolve, reject) => {
      waitResolvers.set(key, {
        resolve: (v) => resolve(v as T),
        reject,
      });
    });
  }

  /**
   * Called on server startup. Finds non-terminal instances in the DB and
   * re-enters their execution. Running stages get reset to pending so they
   * re-execute from the start; waiting gates get re-registered.
   */
  async resumeAllFromDB(): Promise<void> {
    // Query each non-terminal status separately since listInstances only takes a single status filter
    const statuses = ['running', 'waiting_gate', 'waiting_input'] as const;
    const instances = [
      ...this.db.listInstances({ status: 'running', includeTest: true }).data,
      ...this.db.listInstances({ status: 'waiting_gate', includeTest: true }).data,
      ...this.db.listInstances({ status: 'waiting_input', includeTest: true }).data,
    ];

    for (const instance of instances) {
      try {
        const definition = this.db.getInstanceDefinition(instance.id);
        if (!definition) {
          console.warn(`[runner] Cannot recover instance ${instance.id}: no definition`);
          continue;
        }

        // Reset any stages that were mid-execution — they'll re-run from scratch
        const context = instance.context;
        if (context && typeof context === 'object' && 'stages' in context) {
          const stages = (context as WorkflowContext).stages || {};
          const runningStageIds: string[] = [];
          for (const [stageId, stageCtx] of Object.entries(stages)) {
            if (stageCtx && typeof stageCtx === 'object' && 'status' in stageCtx && stageCtx.status === 'running') {
              runningStageIds.push(stageId);
              (stageCtx as { status: string }).status = 'pending';
            }
          }
          if (runningStageIds.length > 0) {
            this.db.updateInstance(instance.id, { context });
            broadcast('instance:updated', { instanceId: instance.id }, { instanceId: instance.id });
            await this.startResume(
              instance.id,
              definition,
              instance.trigger_event as unknown as Event,
              context as WorkflowContext,
              runningStageIds,
            );
          } else if (instance.status === 'waiting_gate') {
            // Instance was idle in a gate wait — resume from the current stage IDs
            const entryIds = (instance.current_stage_ids as string[] | null) ?? [];
            if (entryIds.length > 0) {
              await this.startResume(
                instance.id,
                definition,
                instance.trigger_event as unknown as Event,
                context as WorkflowContext,
                entryIds,
              );
            }
          }
        }
      } catch (err) {
        console.error(`[runner] Failed to recover instance ${instance.id}:`, err);
      }
    }
  }

  /** For shutdown: abort all active instances without marking them failed. */
  async shutdown(): Promise<void> {
    const ids = Array.from(this.active.keys());
    for (const id of ids) {
      const handle = this.active.get(id);
      if (handle) {
        handle.abortController.abort();
      }
    }
    // Wait for all to settle
    await Promise.allSettled(Array.from(this.active.values()).map((h) => h.executionPromise));
  }

  isActive(instanceId: string): boolean {
    return this.active.has(instanceId);
  }
}
