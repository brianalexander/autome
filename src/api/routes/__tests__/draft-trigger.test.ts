import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { EventBus } from '../../../events/bus.js';
import { ManualTriggerProvider } from '../../../events/providers/manual.js';
import { AgentPool } from '../../../acp/pool.js';
import { WorkflowRunner } from '../../../engine/runner.js';
import { registerDraftRoutes } from '../draft.js';
import type { WorkflowDefinition } from '../../../types/workflow.js';
import type { SharedState } from '../shared.js';
import { initializeRegistry, nodeRegistry } from '../../../nodes/registry.js';
import type { NodeTypeSpec, TriggerExecutor, StepExecutor } from '../../../nodes/types.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock broadcast so we can run without real WS infrastructure
// ---------------------------------------------------------------------------
vi.mock('../../websocket.js', () => ({
  broadcast: vi.fn(),
}));

beforeAll(async () => {
  await initializeRegistry();
});

async function buildDraftTriggerApp() {
  const db = new OrchestratorDB(':memory:');

  const eventBus = new EventBus();
  const manualTrigger = new ManualTriggerProvider();
  eventBus.registerProvider(manualTrigger);

  const acpPool = new AgentPool();
  const authorPool = new AgentPool();
  const runner = new WorkflowRunner(db, eventBus, 'http://127.0.0.1:3001');

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps = { db, eventBus, runner, manualTrigger, acpPool, authorPool, orchestratorPort: 3001 };

  const authorDrafts = new Map<string, WorkflowDefinition>();
  const assistantPool = new AgentPool();
  const state: SharedState = {
    runner,
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

  return { app, authorDrafts };
}

describe('PUT /api/draft/:workflowId/trigger', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildDraftTriggerApp());
  });

  it('creates a prompt-trigger stage when provider is "prompt"', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-prompt-test/trigger',
      payload: { provider: 'prompt' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('prompt-trigger');
    expect(body.config.provider).toBe('prompt');
  });

  it('draft reflects prompt-trigger after reading it back', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-prompt-readback/trigger',
      payload: { provider: 'prompt' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/draft/wf-prompt-readback/workflow',
    });

    expect(res.statusCode).toBe(200);
    const draft = res.json();
    const triggerStage = draft.stages.find((s: { type: string }) => s.type === 'prompt-trigger');
    expect(triggerStage).toBeDefined();
    expect(triggerStage.type).toBe('prompt-trigger');
    expect(triggerStage.config.provider).toBe('prompt');
  });

  it('does NOT stamp a manual-trigger when provider is "prompt"', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-prompt-not-manual/trigger',
      payload: { provider: 'prompt' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).not.toBe('manual-trigger');
  });

  it('returns 400 for an unknown provider (no silent fallback)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-unknown-provider/trigger',
      // provider is z.string() so Zod passes; the registry lookup returns
      // undefined and the handler returns 400 with an error message.
      payload: { provider: 'unknown-provider' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('still creates manual-trigger for provider "manual"', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-manual/trigger',
      payload: { provider: 'manual' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('manual-trigger');
  });

  it('still creates webhook-trigger for provider "webhook"', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-webhook/trigger',
      payload: { provider: 'webhook' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('webhook-trigger');
  });

  it('accepts full node type IDs (e.g. cron-trigger) without an alias', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-cron-full-id/trigger',
      payload: { provider: 'cron-trigger' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('cron-trigger');
  });

  it('accepts plugin-style node type IDs registered at runtime', async () => {
    // Register a mock plugin trigger type before this test runs
    const pluginTriggerSpec: NodeTypeSpec = {
      id: 'my:custom-trigger',
      name: 'My Custom Trigger',
      category: 'trigger',
      description: 'A plugin trigger type',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: { type: 'trigger' } as TriggerExecutor,
    };
    nodeRegistry.register(pluginTriggerSpec);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-plugin-trigger/trigger',
      payload: { provider: 'my:custom-trigger' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('my:custom-trigger');
  });

  it('returns 400 when a full node type ID is not a trigger category', async () => {
    // 'agent' is a step node, not a trigger
    const res = await app.inject({
      method: 'PUT',
      url: '/api/draft/wf-step-as-trigger/trigger',
      payload: { provider: 'agent' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a trigger/);
  });
});
