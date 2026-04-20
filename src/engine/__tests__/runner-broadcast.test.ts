/**
 * Regression tests: WorkflowRunner must broadcast 'instance:updated' events
 * after every DB state mutation so the frontend's WS invalidation fires AFTER
 * the write has landed, not before.
 *
 * Bug: route handlers (workflow_signal, etc.) were broadcasting BEFORE the
 * runner's async setContext/setStatus writes persisted, causing the UI to
 * refetch stale data and never receive a follow-up notification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestratorDB } from '../../db/database.js';
import { EventBus } from '../../events/bus.js';
import { WorkflowRunner } from '../runner.js';

// ---------------------------------------------------------------------------
// Mock broadcast — must be hoisted before any imports of runner.ts
// ---------------------------------------------------------------------------

const broadcastMock = vi.fn();
vi.mock('../../api/websocket.js', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): OrchestratorDB {
  return new OrchestratorDB(':memory:');
}

// ---------------------------------------------------------------------------
// Unit-level tests: cancel paths (synchronous, no pipeline involved)
// ---------------------------------------------------------------------------

describe('WorkflowRunner — broadcast on ExecutionContext mutations', () => {
  let db: OrchestratorDB;
  let eventBus: EventBus;
  let runner: WorkflowRunner;

  beforeEach(() => {
    broadcastMock.mockClear();
    db = makeDb();
    eventBus = new EventBus();
    runner = new WorkflowRunner(db, eventBus, 'http://127.0.0.1:3001');
  });

  afterEach(() => {
    db.close();
  });

  // Helper: create a real instance and return its id
  function createTestInstance(): string {
    const inst = db.createInstance({
      definition_id: null,
      definition_version: null,
      status: 'running',
      trigger_event: { id: 'ev-1', provider: 'manual', type: 'manual', payload: {}, timestamp: new Date().toISOString() },
      context: { stages: {}, trigger: {}, edgeTraversals: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });
    return inst.id;
  }

  it('cancel() broadcasts instance:updated when instance is not in memory', () => {
    const instanceId = createTestInstance();
    // Instance is not in runner's active map — cancel should update DB + broadcast
    runner.cancel(instanceId);

    expect(broadcastMock).toHaveBeenCalledWith(
      'instance:updated',
      expect.objectContaining({ instanceId, status: 'cancelled' }),
      { instanceId },
    );
  });

  it('cancel() broadcasts instance:updated when timeout forces cancellation', async () => {
    vi.useFakeTimers();
    const instanceId = createTestInstance();

    // Build a runner where the executionPromise never settles
    let neverResolve!: () => void;
    const hangingPromise = new Promise<void>((resolve) => { neverResolve = resolve; });

    // Inject a fake active handle that hangs
    const handle = {
      instanceId,
      abortController: new AbortController(),
      executionPromise: hangingPromise,
      waitResolvers: new Map(),
    };
    (runner as any).active.set(instanceId, handle);

    const cancelPromise = runner.cancel(instanceId);
    // Advance past the 5000ms timeout
    await vi.advanceTimersByTimeAsync(6000);
    await cancelPromise;

    expect(broadcastMock).toHaveBeenCalledWith(
      'instance:updated',
      expect.objectContaining({ instanceId, status: 'cancelled' }),
      { instanceId },
    );

    vi.useRealTimers();
    neverResolve();
  });
});

// ---------------------------------------------------------------------------
// Integration-level: verify broadcast fires during a real pipeline run
// ---------------------------------------------------------------------------

describe('WorkflowRunner — broadcast on full pipeline execution', () => {
  let db: OrchestratorDB;
  let eventBus: EventBus;

  beforeEach(async () => {
    broadcastMock.mockClear();
    db = makeDb();
    eventBus = new EventBus();

    // Initialize the node registry so the pipeline can resolve stage types
    const { initializeRegistry } = await import('../../nodes/registry.js');
    await initializeRegistry();
  });

  afterEach(() => {
    db.close();
  });

  it('broadcasts instance:updated for setStatus, setContext, and setCurrentStageIds at pipeline start', async () => {
    // Create a minimal workflow with just a trigger stage (no executable work stages)
    const workflow = db.createWorkflow({
      name: 'Broadcast Test Workflow',
      active: true,
      trigger: { provider: 'manual' },
      stages: [
        { id: 'trigger', type: 'prompt-trigger', config: {} },
      ],
      edges: [],
    } as any);

    const instance = db.createInstance({
      definition_id: workflow.id,
      definition_version: workflow.version ?? 1,
      status: 'running',
      trigger_event: { id: 'ev-trigger', provider: 'manual', type: 'manual', payload: { message: 'hi' }, timestamp: new Date().toISOString() },
      context: { stages: {}, trigger: {}, edgeTraversals: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const runner = new WorkflowRunner(db, eventBus, 'http://127.0.0.1:3001');
    const triggerEvent = { id: 'ev-trigger', provider: 'manual', type: 'manual', payload: { message: 'hi' }, timestamp: new Date().toISOString() };

    await runner.start(instance.id, workflow, triggerEvent as any);

    // Wait for the background executionPromise to settle. runner.start() returns
    // before the pipeline promise resolves, so we pull it from the active map.
    // If the instance has already finished (removed from active), settle immediately.
    const handle = (runner as any).active.get(instance.id);
    if (handle) {
      await handle.executionPromise.catch(() => {});
    }

    // The pipeline calls setStatus('running'), setContext(...), setCurrentStageIds([])
    // at minimum — each must produce a broadcast call.
    const instanceUpdatedCalls = broadcastMock.mock.calls.filter(
      ([event]) => event === 'instance:updated',
    );

    expect(instanceUpdatedCalls.length).toBeGreaterThanOrEqual(3);

    // All calls must be scoped to this instance
    for (const [, , scope] of instanceUpdatedCalls) {
      expect(scope).toEqual({ instanceId: instance.id });
    }

    // At least one call carries a status field
    const withStatus = instanceUpdatedCalls.filter(([, data]) => 'status' in (data as object));
    expect(withStatus.length).toBeGreaterThanOrEqual(1);
  });
});
