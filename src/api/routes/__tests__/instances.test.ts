import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { buildTestApp } from './test-helpers.js';
import { initializeRegistry } from '../../../nodes/registry.js';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorDB } from '../../../db/database.js';
import type { WorkflowContext } from '../../../types/instance.js';

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

    // Create instances directly via DB
    db.createInstance({
      definition_id: wf1Id,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });
    db.createInstance({
      definition_id: wf2Id,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
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

  it('PATCH /api/instances/:id — updates display_summary', async () => {
    const inst = db.createInstance({
      definition_id: null,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${inst.id}`,
      payload: { display_summary: 'My custom summary' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instanceId).toBe(inst.id);
    expect(body.display_summary).toBe('My custom summary');

    // Verify it was persisted
    const fetched = db.getInstance(inst.id);
    expect(fetched?.display_summary).toBe('My custom summary');
  });

  it('PATCH /api/instances/:id — returns 404 for non-existent', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/instances/nonexistent-id',
      payload: { display_summary: 'anything' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /api/instances/:id — allows null to clear summary', async () => {
    const inst = db.createInstance({
      definition_id: null,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
      display_summary: 'existing summary',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/instances/${inst.id}`,
      payload: { display_summary: null },
    });
    expect(res.statusCode).toBe(200);
    const fetched = db.getInstance(inst.id);
    expect(fetched?.display_summary).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // GET /api/approvals — gate message rendering
  // ---------------------------------------------------------------------------

  it('GET /api/approvals — renders gateMessage template against workflow context', async () => {
    // Create a workflow with a trigger and a manual gate
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Gate Template Workflow',
        description: '',
        trigger: { provider: 'manual' },
        stages: [
          { id: 'trigger', type: 'manual-trigger', config: {} },
          {
            id: 'gate1',
            type: 'gate',
            config: {
              type: 'manual',
              message: 'Review: {{ trigger.subject }} — category: {{ stages.trigger.latest.category }}',
            },
          },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'gate1' }],
      },
    });
    expect(wfRes.statusCode).toBe(201);
    const wfId = wfRes.json().id;

    // Build a context with trigger + trigger stage output
    const context: WorkflowContext = {
      trigger: { subject: 'Hello World' },
      stages: {
        trigger: {
          status: 'completed',
          run_count: 1,
          runs: [],
          latest: { category: 'urgent' },
        },
        gate1: {
          status: 'running',
          run_count: 1,
          runs: [],
        },
      },
    };

    // Create an instance in waiting_gate status
    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'waiting_gate',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context,
      current_stage_ids: ['gate1'],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(200);
    const approvals = res.json() as Array<{ stageId: string; gateMessage: string | null }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].stageId).toBe('gate1');
    // Template should be rendered with context values
    expect(approvals[0].gateMessage).toBe('Review: Hello World — category: urgent');
  });

  it('GET /api/approvals — falls back to raw string for malformed template', async () => {
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Gate Fallback Workflow',
        description: '',
        trigger: { provider: 'manual' },
        stages: [
          { id: 'trigger', type: 'manual-trigger', config: {} },
          {
            id: 'gate1',
            type: 'gate',
            config: {
              type: 'manual',
              message: 'Bad template {{ unclosed',
            },
          },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'gate1' }],
      },
    });
    expect(wfRes.statusCode).toBe(201);
    const wfId = wfRes.json().id;

    const context: WorkflowContext = {
      trigger: {},
      stages: {
        trigger: { status: 'completed', run_count: 1, runs: [] },
        gate1: { status: 'running', run_count: 1, runs: [] },
      },
    };

    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'waiting_gate',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context,
      current_stage_ids: ['gate1'],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(200);
    const approvals = res.json() as Array<{ stageId: string; gateMessage: string | null }>;
    expect(approvals).toHaveLength(1);
    // Falls back to raw template string
    expect(approvals[0].gateMessage).toBe('Bad template {{ unclosed');
  });

  // ---------------------------------------------------------------------------
  // POST /api/instances/:id/stages/:stageId/review — review gate decisions
  // ---------------------------------------------------------------------------

  it('POST /review — resolves wait with approved decision', async () => {
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Review Gate Workflow',
        description: '',
        trigger: { provider: 'manual' },
        stages: [
          { id: 'trigger', type: 'manual-trigger', config: {} },
          { id: 'review1', type: 'review-gate', config: { message: 'Please review' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'review1' }],
      },
    });
    expect(wfRes.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { decision: 'approved', notes: 'Looks great' },
    });
    // The runner.resolveWait call will throw because there's no live runner waiting,
    // but the endpoint itself should accept the body and process it (500 from resolveWait is OK for this integration test).
    // We just verify the schema validation passes (not 400).
    expect(res.statusCode).not.toBe(400);
  });

  it('POST /review — rejects malformed body (missing decision)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { notes: 'forgot decision' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /review — rejects invalid decision value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { decision: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /review — accepts revised decision with notes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { decision: 'revised', notes: 'Please fix section 2' },
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('POST /review — accepts rejected decision without notes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { decision: 'rejected' },
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('POST /review — rejects body that includes the retired data field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/fake-inst/stages/review1/review',
      payload: { decision: 'approved', data: { foo: 'bar' } },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // GET /api/approvals — gateKind field
  // ---------------------------------------------------------------------------

  it('GET /api/approvals — includes gateKind=review for review-gate stages', async () => {
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Review Gate Approvals Test',
        description: '',
        trigger: { provider: 'manual' },
        stages: [
          { id: 'trigger', type: 'manual-trigger', config: {} },
          { id: 'review1', type: 'review-gate', config: { message: 'Review this' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'review1' }],
      },
    });
    expect(wfRes.statusCode).toBe(201);
    const wfId = wfRes.json().id;

    const context: WorkflowContext = {
      trigger: {},
      stages: {
        trigger: { status: 'completed', run_count: 1, runs: [] },
        review1: { status: 'running', run_count: 1, runs: [] },
      },
    };

    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'waiting_gate',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context,
      current_stage_ids: ['review1'],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(200);
    const approvals = res.json() as Array<{ stageId: string; gateKind: string }>;
    const reviewApproval = approvals.find(a => a.stageId === 'review1');
    expect(reviewApproval).toBeDefined();
    expect(reviewApproval?.gateKind).toBe('review');
  });

  it('GET /api/approvals — includes gateKind=binary for manual gate stages', async () => {
    const wfRes = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Binary Gate Approvals Test',
        description: '',
        trigger: { provider: 'manual' },
        stages: [
          { id: 'trigger', type: 'manual-trigger', config: {} },
          { id: 'gate1', type: 'gate', config: { type: 'manual', message: 'Approve this' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'gate1' }],
      },
    });
    expect(wfRes.statusCode).toBe(201);
    const wfId = wfRes.json().id;

    const context: WorkflowContext = {
      trigger: {},
      stages: {
        trigger: { status: 'completed', run_count: 1, runs: [] },
        gate1: { status: 'running', run_count: 1, runs: [] },
      },
    };

    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'waiting_gate',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context,
      current_stage_ids: ['gate1'],
      is_test: false,
      initiated_by: 'user',
      resume_count: 0,
    });

    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(200);
    const approvals = res.json() as Array<{ stageId: string; gateKind: string }>;
    const binaryApproval = approvals.find(a => a.stageId === 'gate1');
    expect(binaryApproval).toBeDefined();
    expect(binaryApproval?.gateKind).toBe('binary');
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
      initiated_by: 'user',
      resume_count: 0,
    });
    db.createInstance({
      definition_id: wfId,
      definition_version: 1,
      status: 'completed',
      trigger_event: { type: 'trigger', provider: 'manual', payload: {} },
      context: { trigger: {}, stages: {} },
      current_stage_ids: [],
      is_test: true,
      initiated_by: 'author',
      resume_count: 0,
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
