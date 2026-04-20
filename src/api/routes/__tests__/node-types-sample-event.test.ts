import { describe, it, expect, beforeAll, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { AgentPool } from '../../../acp/pool.js';
import { registerAgentRoutes } from '../agents.js';
import { nodeRegistry, initializeRegistry } from '../../../nodes/registry.js';
import type { NodeTypeSpec, TriggerExecutor, StepExecutor } from '../../../nodes/types.js';
import type { FastifyInstance } from 'fastify';
import type { SharedState } from '../shared.js';

// ---------------------------------------------------------------------------
// Mock broadcast so tests never need WS infrastructure
// ---------------------------------------------------------------------------
vi.mock('../../websocket.js', () => ({
  broadcast: vi.fn(),
}));

beforeAll(async () => {
  await initializeRegistry();
});

// ---------------------------------------------------------------------------
// Helper — build a minimal Fastify app with just the agent routes
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const db = new OrchestratorDB(':memory:');
  const acpPool = new AgentPool();
  const authorPool = new AgentPool();
  const assistantPool = new AgentPool();

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps = { db, acpPool, authorPool, orchestratorPort: 3001 } as Parameters<typeof registerAgentRoutes>[1];
  const state: SharedState = {
    runner: undefined as unknown as SharedState['runner'],
    authorPool,
    acpPool,
    assistantPool,
    forceStoppedStages: new Set(),
    signalledStages: new Set(),
    authorDrafts: new Map(),
    authorSpecSent: new Set(),
    stageTimeouts: new Map(),
  };

  registerAgentRoutes(app, deps, state);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Helpers to register mock node types
// ---------------------------------------------------------------------------

function makeMockTrigger(id: string, withSampleEvent: boolean): NodeTypeSpec {
  const executor: TriggerExecutor = {
    type: 'trigger',
    activate: async () => () => {},
    ...(withSampleEvent
      ? {
          sampleEvent: (config) => ({
            source: 'mock',
            schedule: (config.schedule as string) ?? 'default',
          }),
        }
      : {}),
  };
  return {
    id,
    name: id,
    category: 'trigger',
    description: 'Mock trigger for tests',
    icon: 'zap',
    color: { bg: '#fff', border: '#000', text: '#000' },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    executor,
  };
}

function makeMockStep(id: string): NodeTypeSpec {
  const executor: StepExecutor = {
    type: 'step',
    execute: async () => ({ output: {} }),
  };
  return {
    id,
    name: id,
    category: 'step',
    description: 'Mock step for tests',
    icon: 'box',
    color: { bg: '#fff', border: '#000', text: '#000' },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    executor,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/node-types/:id/sample-event', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Register mock types before building the app so they are available
    nodeRegistry.register(makeMockTrigger('mock-trigger-with-sample', true));
    nodeRegistry.register(makeMockTrigger('mock-trigger-no-sample', false));
    nodeRegistry.register(makeMockStep('mock-step'));
    app = await buildApp();
  });

  it('returns the sample event payload for a trigger with sampleEvent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/mock-trigger-with-sample/sample-event',
      payload: { config: { schedule: '10m' } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('mock');
    expect(body.schedule).toBe('10m');
  });

  it('uses empty config when no config provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/mock-trigger-with-sample/sample-event',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('mock');
    expect(body.schedule).toBe('default');
  });

  it('returns 404 for a trigger that does not implement sampleEvent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/mock-trigger-no-sample/sample-event',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/sampleEvent/);
  });

  it('returns 400 for a non-trigger node type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/mock-step/sample-event',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a trigger/);
  });

  it('returns 404 for an unknown node type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/does-not-exist/sample-event',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/Unknown node type/);
  });

  it('cron-trigger returns a well-shaped sample event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/node-types/cron-trigger/sample-event',
      payload: { config: { schedule: '15m' } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('cron');
    expect(body.schedule).toBe('15m');
    expect(typeof body.timestamp).toBe('string');
  });
});
