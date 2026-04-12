/**
 * Tests for POST /api/internal/ui-action
 * Verifies body validation and broadcast call with correct scoping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { EventBus } from '../../../events/bus.js';
import { ManualTriggerProvider } from '../../../events/providers/manual.js';
import { AgentPool } from '../../../acp/pool.js';
import { registerInternalRoutes } from '../internal.js';
import type { WorkflowDefinition } from '../../../types/workflow.js';
import type { SharedState } from '../shared.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock broadcast so we can assert calls without real WS infrastructure
// ---------------------------------------------------------------------------
const broadcastMock = vi.fn();
vi.mock('../../websocket.js', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

// registerAuthorRoutes calls app.swagger() — stub that out
vi.mock('../internal-author.js', () => ({
  registerAuthorRoutes: vi.fn(),
}));
vi.mock('../internal-restate.js', () => ({
  registerRestateRoutes: vi.fn(),
}));

async function buildApp(): Promise<FastifyInstance> {
  const db = new OrchestratorDB(':memory:');
  const eventBus = new EventBus();
  const manualTrigger = new ManualTriggerProvider();
  eventBus.registerProvider(manualTrigger);
  const acpPool = new AgentPool();
  const authorPool = new AgentPool();

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps = { db, eventBus, manualTrigger, acpPool, authorPool };
  const authorDrafts = new Map<string, WorkflowDefinition>();
  const assistantPool = new AgentPool();
  const state: SharedState = {
    authorPool,
    acpPool,
    assistantPool,
    forceStoppedStages: new Set<string>(),
    signalledStages: new Set<string>(),
    authorDrafts,
    authorSpecSent: new Set<string>(),
    stageTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
  };

  registerInternalRoutes(app, deps, state);

  await app.ready();
  return app;
}

describe('POST /api/internal/ui-action', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    broadcastMock.mockClear();
    app = await buildApp();
  });

  it('returns 200 and broadcasts ui:action for show_test_run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        workflowId: 'wf-abc',
        action: 'show_test_run',
        instanceId: 'inst-123',
        testWorkflowId: 'test-wf-123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const call = broadcastMock.mock.calls.find((args: unknown[]) => args[0] === 'ui:action');
    expect(call).toBeDefined();

    const [event, data, scope] = call! as [string, Record<string, unknown>, unknown];
    expect(event).toBe('ui:action');
    expect(data.action).toBe('show_test_run');
    expect(data.workflowId).toBe('wf-abc');
    expect(data.instanceId).toBe('inst-123');
    expect(data.testWorkflowId).toBe('test-wf-123');
    // Scoped to the workflow
    expect(scope).toEqual({ workflowId: 'wf-abc' });
  });

  it('broadcasts without scope when workflowId is omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        action: 'toast',
        level: 'info',
        text: 'Hello from agent',
      },
    });

    expect(res.statusCode).toBe(200);

    const call = broadcastMock.mock.calls.find((args: unknown[]) => args[0] === 'ui:action');
    expect(call).toBeDefined();

    const [, , scope] = call! as [string, unknown, unknown];
    // No workflowId → scope should be undefined (global broadcast)
    expect(scope).toBeUndefined();
  });

  it('returns 400 for unknown action value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        workflowId: 'wf-abc',
        action: 'invalid_action',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when action is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        workflowId: 'wf-abc',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('accepts navigate action with to field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        workflowId: 'wf-abc',
        action: 'navigate',
        to: '/workflows',
      },
    });

    expect(res.statusCode).toBe(200);

    const call = broadcastMock.mock.calls.find((args: unknown[]) => args[0] === 'ui:action');
    expect(call).toBeDefined();
    const [, data] = call! as [string, Record<string, unknown>];
    expect(data.action).toBe('navigate');
    expect(data.to).toBe('/workflows');
  });

  it('accepts highlight_element action', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/ui-action',
      payload: {
        workflowId: 'wf-abc',
        action: 'highlight_element',
        elementId: 'stage-step1',
        pulseMs: 2000,
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
