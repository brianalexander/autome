/**
 * Endpoint tests for Phase 4 trigger observability routes.
 *
 * GET /api/workflows/:id/triggers
 * GET /api/workflows/:id/triggers/:stageId/logs
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { EventBus } from '../../../events/bus.js';
import { ManualTriggerProvider } from '../../../events/providers/manual.js';
import { AgentPool } from '../../../acp/pool.js';
import { WorkflowRunner } from '../../../engine/runner.js';
import { registerTriggerObservabilityRoutes } from '../triggers.js';
import { registerWorkflowRoutes } from '../workflows.js';
import {
  initTriggerLifecycle,
  activateWorkflowTriggers,
  resetForTesting,
} from '../../../engine/trigger-lifecycle.js';
import { initializeRegistry, nodeRegistry } from '../../../nodes/registry.js';
import type { NodeTypeSpec, TriggerExecutor, TriggerActivateContext } from '../../../nodes/types.js';
import type { WorkflowDefinition } from '../../../types/workflow.js';
import type { SharedState } from '../shared.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock broadcast to avoid real WS
// ---------------------------------------------------------------------------
vi.mock('../../websocket.js', () => ({ broadcast: vi.fn() }));

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function buildApp(): Promise<{ app: FastifyInstance; db: OrchestratorDB; bus: EventBus }> {
  const db = new OrchestratorDB(':memory:');
  const bus = new EventBus();
  const manualTrigger = new ManualTriggerProvider();
  bus.registerProvider(manualTrigger);

  const acpPool = new AgentPool();
  const authorPool = new AgentPool();
  const runner = new WorkflowRunner(db, bus, 'http://127.0.0.1:3001');

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps = { db, eventBus: bus, runner, manualTrigger, acpPool, authorPool, orchestratorPort: 3001 };

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

  registerWorkflowRoutes(app, deps, state);
  registerTriggerObservabilityRoutes(app, deps);

  await app.ready();
  initTriggerLifecycle(bus);

  return { app, db, bus };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initializeRegistry();
});

beforeEach(async () => {
  resetForTesting();
});

afterEach(() => {
  resetForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/workflows/:id/triggers', () => {
  it('returns 404 for unknown workflow', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/workflows/does-not-exist/triggers' });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty triggers for a workflow with no active triggers', async () => {
    const { app, db } = await buildApp();

    const workflow = db.createWorkflow({
      name: 'Test WF',
      active: false,
      trigger: { provider: 'manual' },
      stages: [],
      edges: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/workflows/${workflow.id}/triggers`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ triggers: {} });
  });

  it('returns trigger statuses for an activated workflow', async () => {
    const { app, db, bus } = await buildApp();

    // Register a test trigger type
    nodeRegistry.register({
      id: 'obs-test-trigger',
      name: 'Obs Test Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          ctx.logger.info('activated');
          ctx.emit({ type: 'test' });
          return () => {};
        },
      } as TriggerExecutor,
    } satisfies NodeTypeSpec);

    const workflow = db.createWorkflow({
      name: 'Observable WF',
      active: true,
      trigger: { provider: 'obs-test-trigger' },
      stages: [{ id: 'ot1', type: 'obs-test-trigger', config: {} }],
      edges: [],
    } as unknown as Parameters<typeof db.createWorkflow>[0]);

    // Activate triggers
    initTriggerLifecycle(bus);
    await activateWorkflowTriggers(workflow as never);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workflows/${workflow.id}/triggers`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { triggers: Record<string, { state: string; eventCount: number; logsPreview: string[] }> };
    expect(body.triggers).toHaveProperty('ot1');
    expect(body.triggers['ot1'].state).toBe('active');
    expect(body.triggers['ot1'].eventCount).toBe(1);
    expect(Array.isArray(body.triggers['ot1'].logsPreview)).toBe(true);
  });
});

describe('GET /api/workflows/:id/triggers/:stageId/logs', () => {
  it('returns 404 for unknown workflow', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/workflows/no-wf/triggers/no-stage/logs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns empty lines for a stage with no logs', async () => {
    const { app, db } = await buildApp();

    const workflow = db.createWorkflow({
      name: 'Empty Logs WF',
      active: false,
      trigger: { provider: 'manual' },
      stages: [],
      edges: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/workflows/${workflow.id}/triggers/no-stage/logs`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: [] });
  });

  it('returns log lines for an activated trigger', async () => {
    const { app, db, bus } = await buildApp();

    nodeRegistry.register({
      id: 'log-test-trigger',
      name: 'Log Test Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          ctx.logger.info('first log line');
          ctx.logger.warn('second log line');
          return () => {};
        },
      } as TriggerExecutor,
    } satisfies NodeTypeSpec);

    const workflow = db.createWorkflow({
      name: 'Log Lines WF',
      active: true,
      trigger: { provider: 'log-test-trigger' },
      stages: [{ id: 'lt1', type: 'log-test-trigger', config: {} }],
      edges: [],
    } as unknown as Parameters<typeof db.createWorkflow>[0]);

    initTriggerLifecycle(bus);
    await activateWorkflowTriggers(workflow as never);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workflows/${workflow.id}/triggers/lt1/logs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { lines: string[] };
    expect(body.lines.some((l) => l.includes('first log line'))).toBe(true);
    expect(body.lines.some((l) => l.includes('second log line'))).toBe(true);
  });

  it('respects the limit query parameter', async () => {
    const { app, db, bus } = await buildApp();

    nodeRegistry.register({
      id: 'limit-log-trigger',
      name: 'Limit Log Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          for (let i = 0; i < 100; i++) {
            ctx.logger.info(`line ${i}`);
          }
          return () => {};
        },
      } as TriggerExecutor,
    } satisfies NodeTypeSpec);

    const workflow = db.createWorkflow({
      name: 'Limit Log WF',
      active: true,
      trigger: { provider: 'limit-log-trigger' },
      stages: [{ id: 'll1', type: 'limit-log-trigger', config: {} }],
      edges: [],
    } as unknown as Parameters<typeof db.createWorkflow>[0]);

    initTriggerLifecycle(bus);
    await activateWorkflowTriggers(workflow as never);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workflows/${workflow.id}/triggers/ll1/logs?limit=10`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { lines: string[] };
    expect(body.lines.length).toBe(10);
  });
});
