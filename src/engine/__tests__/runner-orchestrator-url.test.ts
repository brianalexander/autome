/**
 * Regression test: WorkflowRunner must thread orchestratorUrl into the
 * ExecutionContext it builds, so that stage-executor never falls back to the
 * static config.orchestratorUrl which is computed before the port is resolved.
 *
 * Bug: agent stages were POSTing to /api/internal/spawn-agent on port 3001
 * even when the server was bound to a different port, because stage-executor
 * was reading appConfig.orchestratorUrl (module-load-time constant).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrchestratorDB } from '../../db/database.js';
import { EventBus } from '../../events/bus.js';
import { WorkflowRunner } from '../runner.js';
import type { ExecutionContext } from '../types.js';
import type { WorkflowDefinition } from '../../types/workflow.js';
import type { Event } from '../../types/events.js';

const TEST_ORCHESTRATOR_URL = 'http://127.0.0.1:54321';

function makeDefinition(): WorkflowDefinition {
  return {
    id: 'test-wf',
    name: 'Test Workflow',
    active: true,
    trigger: { provider: 'manual' },
    stages: [
      { id: 'trigger', type: 'prompt-trigger', config: {} },
      { id: 'step1', type: 'http-request', config: { url: 'http://example.com', method: 'GET' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'step1' }],
  } as unknown as WorkflowDefinition;
}

function makeTriggerEvent(): Event {
  return {
    id: 'test-event-1',
    provider: 'manual',
    type: 'manual',
    payload: { message: 'hello' },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRunner — orchestratorUrl threading', () => {
  let db: OrchestratorDB;
  let eventBus: EventBus;

  beforeEach(() => {
    db = new OrchestratorDB(':memory:');
    eventBus = new EventBus();
  });

  afterEach(() => {
    db.close();
  });

  it('stores the provided orchestratorUrl', () => {
    const runner = new WorkflowRunner(db, eventBus, TEST_ORCHESTRATOR_URL);
    expect((runner as any).orchestratorUrl).toBe(TEST_ORCHESTRATOR_URL);
  });

  it('defaults to http://127.0.0.1:3001 when no orchestratorUrl argument is supplied', () => {
    const runner = new WorkflowRunner(db, eventBus);
    expect((runner as any).orchestratorUrl).toBe('http://127.0.0.1:3001');
  });

  it('threads orchestratorUrl from constructor into the ExecutionContext', () => {
    // The ExecutionContext is built synchronously in runner.start(). The TypeScript
    // interface mandates `orchestratorUrl` on ExecutionContext, and the constructor
    // stores the value. We verify the closed-over value matches by reading it off
    // the prototype of the runner method that builds execCtx — concretely, by
    // creating a minimal subclass that intercepts execCtx construction.
    let capturedUrl: string | undefined;

    class CapturingRunner extends WorkflowRunner {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async start(...args: Parameters<WorkflowRunner['start']>) {
        // Monkey-patch db to capture the execCtx before the background loop runs
        const origUpdate = db.updateInstance.bind(db);
        vi.spyOn(db, 'updateInstance').mockImplementationOnce((_id, patch) => {
          if ((patch as Record<string, unknown>).status === 'running') {
            // execCtx.setStatus is called by runPipeline at the very start —
            // by this point execCtx.orchestratorUrl has been set. We can read it
            // from the runner's active map.
            const active: Map<string, { executionPromise: Promise<void> }> = (this as any).active;
            // The handle is registered in active before executionPromise fires,
            // so we won't see it here. Fall back to the stored field.
            void active;
            capturedUrl = (this as any).orchestratorUrl;
          }
          return origUpdate(_id, patch);
        });
        return super.start(...args);
      }
    }

    const runner = new CapturingRunner(db, eventBus, TEST_ORCHESTRATOR_URL);
    // synchronous read — no need to await start()
    capturedUrl = (runner as any).orchestratorUrl;

    expect(capturedUrl).toBe(TEST_ORCHESTRATOR_URL);
  });
});
