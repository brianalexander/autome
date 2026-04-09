import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildTestApp } from './test-helpers.js';
import { initializeRegistry } from '../../../nodes/registry.js';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorDB } from '../../../db/database.js';

// Initialize the node registry once — needed for stage config and graph validation
beforeAll(async () => {
  await initializeRegistry();
});

const minimalWorkflow = {
  name: 'Test Workflow',
  description: 'A test',
  trigger: { provider: 'manual' },
  stages: [
    { id: 'trigger', type: 'manual-trigger', config: {} },
    { id: 'step1', type: 'code-executor', config: { code: 'return {}', output_schema: { type: 'object' } } },
  ],
  edges: [{ id: 'edge_trigger_step1', source: 'trigger', target: 'step1' }],
};

describe('Workflow routes', () => {
  let app: FastifyInstance;
  let db: OrchestratorDB;

  beforeEach(async () => {
    ({ app, db } = await buildTestApp());
  });

  it('GET /api/workflows — returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('POST /api/workflows — creates a workflow, returns it with ID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Test Workflow');
    expect(body.version).toBe(1);
  });

  it('GET /api/workflows/:id — returns the created workflow', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: 'GET', url: `/api/workflows/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('GET /api/workflows/:id — returns 404 for non-existent ID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/nonexistent-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Workflow not found');
  });

  it('PUT /api/workflows/:id — updates name, returns updated', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: { name: 'Updated Name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated Name');
  });

  it('PUT /api/workflows/:id — version increments on definition change', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id, version: v1 } = createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: { name: 'Changed Name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(v1 + 1);
  });

  it('PUT /api/workflows/:id with only edges — validates graph (HIGH-5 regression)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    // Provide an edge that references a non-existent stage
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${id}`,
      payload: {
        edges: [{ source: 'trigger', target: 'does-not-exist' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('does-not-exist');
  });

  it('DELETE /api/workflows/:id — returns 204', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: 'DELETE', url: `/api/workflows/${id}` });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE /api/workflows/:id — returns 404 for non-existent (HIGH-6 regression)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/workflows/nonexistent-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Workflow not found');
  });

  it('POST /api/workflows/:id/clone — creates a copy with "(Copy)" suffix', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: 'POST', url: `/api/workflows/${id}/clone` });
    expect(res.statusCode).toBe(201);
    const clone = res.json();
    expect(clone.id).not.toBe(id);
    expect(clone.name).toBe('Test Workflow (Copy)');
    expect(clone.active).toBe(false);
  });

  it('POST /api/workflows/:id/activate — sets active=true', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: minimalWorkflow,
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: 'POST', url: `/api/workflows/${id}/activate` });
    expect(res.statusCode).toBe(200);
    expect(res.json().activated).toBe(true);

    const workflow = db.getWorkflow(id);
    expect(workflow?.active).toBe(true);
  });

  it('POST /api/workflows/:id/deactivate — sets active=false', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { ...minimalWorkflow, active: true },
    });
    const { id } = createRes.json();

    const res = await app.inject({ method: 'POST', url: `/api/workflows/${id}/deactivate` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deactivated).toBe(true);

    const workflow = db.getWorkflow(id);
    expect(workflow?.active).toBe(false);
  });
});
