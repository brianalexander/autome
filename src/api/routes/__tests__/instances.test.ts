import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildTestApp } from './test-helpers.js';
import { initializeRegistry } from '../../../nodes/registry.js';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorDB } from '../../../db/database.js';

beforeAll(async () => {
  await initializeRegistry();
});

const minimalWorkflow = {
  name: 'Instance Test Workflow',
  description: 'A test',
  trigger: { provider: 'manual' },
  stages: [
    { id: 'trigger', type: 'manual-trigger', config: {} },
    { id: 'step1', type: 'code-executor', config: { code: 'return {}', output_schema: { type: 'object' } } },
  ],
  edges: [{ id: 'edge_trigger_step1', source: 'trigger', target: 'step1' }],
};

describe('Instance routes', () => {
  let app: FastifyInstance;
  let db: OrchestratorDB;

  beforeEach(async () => {
    ({ app, db } = await buildTestApp());
  });

  it('GET /api/instances — returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instances' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('GET /api/instances/:id — returns 404 for non-existent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instances/nonexistent-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Instance not found');
  });

  it('GET /api/instances — filters by definitionId', async () => {
    // Create two workflows and one instance each
    const wf1Res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { ...minimalWorkflow, name: 'Workflow 1' },
    });
    const wf2Res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { ...minimalWorkflow, name: 'Workflow 2' },
    });
    const wf1Id = wf1Res.json().id;
    const wf2Id = wf2Res.json().id;

    // Create instances directly via DB to avoid Restate dependency
    db.createInstance({
      definition_id: wf1Id,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
    });
    db.createInstance({
      definition_id: wf2Id,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/instances?definitionId=${wf1Id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].definition_id).toBe(wf1Id);
  });

  it('GET /api/instances — excludes test instances by default', async () => {
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const wfId = wfRes.json().id;

    // Create one regular and one test instance
    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
    });
    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: true,
    });

    const res = await app.inject({ method: 'GET', url: '/api/instances' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only the non-test instance should be returned
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].is_test).toBeFalsy();
  });
});
