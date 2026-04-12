import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { EventBus } from '../../../events/bus.js';
import { ManualTriggerProvider } from '../../../events/providers/manual.js';
import { AgentPool } from '../../../acp/pool.js';
import { registerDraftRoutes } from '../draft.js';
import type { WorkflowDefinition } from '../../../types/workflow.js';
import type { SharedState } from '../shared.js';
import { initializeRegistry } from '../../../nodes/registry.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock broadcast so we can assert calls without real WS infrastructure
// ---------------------------------------------------------------------------
const broadcastMock = vi.fn();
vi.mock('../../websocket.js', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

beforeAll(async () => {
  await initializeRegistry();
});

async function buildDraftTestApp() {
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

  registerDraftRoutes(app, deps, state);

  await app.ready();

  return { app, db, authorDrafts };
}

/** Seed a minimal draft workflow directly into the authorDrafts map. */
const minimalDraft: WorkflowDefinition = {
  id: 'wf-test',
  name: 'Draft Workflow',
  description: '',
  version: 1,
  active: true,
  trigger: { provider: 'manual' },
  stages: [
    { id: 'trigger', type: 'manual-trigger', config: {}, position: { x: 0, y: 0 } } as never,
    {
      id: 'step1',
      type: 'code-executor',
      config: { code: 'return {}', output_schema: { type: 'object' } },
      position: { x: 0, y: 150 },
    } as never,
  ],
  edges: [{ id: 'edge_trigger_step1', source: 'trigger', target: 'step1' }] as never,
};

describe('POST /api/draft/:workflowId/test-run', () => {
  let app: FastifyInstance;
  let authorDrafts: Map<string, WorkflowDefinition>;

  beforeEach(async () => {
    broadcastMock.mockClear();
    ({ app, authorDrafts } = await buildDraftTestApp());
    // Seed the draft
    authorDrafts.set('wf-test', { ...minimalDraft });
  });

  it('returns 201 with instance and testWorkflowId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft/wf-test/test-run',
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.instance).toBeDefined();
    expect(body.instance.id).toBeTruthy();
    expect(body.testWorkflowId).toBeTruthy();
  });

  it('broadcasts author:test_run_started with correct fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft/wf-test/test-run',
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const { instance, testWorkflowId } = res.json();

    // Find the specific author:test_run_started call (broadcast may be called multiple
    // times by launchWorkflow internals for other events like instance:created)
    const startedCall = broadcastMock.mock.calls.find((args: unknown[]) => args[0] === 'author:test_run_started');
    expect(startedCall).toBeDefined();

    const [event, data, scope] = startedCall! as [string, Record<string, unknown>, unknown];
    expect(event).toBe('author:test_run_started');
    expect(data.workflowId).toBe('wf-test');
    expect(data.instanceId).toBe(instance.id);
    expect(data.testWorkflowId).toBe(testWorkflowId);
    expect(data.startedAt).toBeTruthy();
    // Scoped to the parent workflow
    expect(scope).toEqual({ workflowId: 'wf-test' });
  });
});
