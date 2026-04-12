/**
 * Test-run inspection routes.
 *
 * Public routes (prefixed /api/test-runs):
 *   GET  /api/test-runs/:instanceId           — snapshot of a single test run
 *   GET  /api/test-runs                       — list test runs for a parent workflow
 *
 * Internal route (prefixed /api/internal):
 *   POST /api/internal/test-runs/cleanup      — delete old test workflows (called by MCP start_test_run)
 */
import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';
import { errorMessage } from '../../utils/errors.js';
import { cleanupAuthorTestRuns } from '../../workflow/test-run-janitor.js';
import type { WorkflowContext, StageContext } from '../../types/instance.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a raw instance status → typed union (handles 'pending' which isn't in the DB enum). */
type RunStatus = 'running' | 'waiting_gate' | 'waiting_input' | 'completed' | 'failed' | 'cancelled' | 'pending';

function computeProgress(stages: Record<string, StageContext>): {
  completed: number;
  running: number;
  pending: number;
  failed: number;
  total: number;
} {
  let completed = 0,
    running = 0,
    pending = 0,
    failed = 0;
  for (const ctx of Object.values(stages)) {
    switch (ctx.status) {
      case 'completed':
        completed++;
        break;
      case 'running':
        running++;
        break;
      case 'pending':
        pending++;
        break;
      case 'failed':
        failed++;
        break;
    }
  }
  return { completed, running, pending, failed, total: Object.keys(stages).length };
}

function buildStageSummary(
  stages: Record<string, StageContext>,
): Array<{
  stageId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  runCount: number;
  latestError?: string;
}> {
  return Object.entries(stages).map(([stageId, ctx]) => {
    const latestRun = ctx.runs?.[ctx.runs.length - 1];
    return {
      stageId,
      status: ctx.status,
      startedAt: latestRun?.started_at,
      completedAt: latestRun?.completed_at,
      runCount: ctx.run_count,
      ...(latestRun?.error ? { latestError: latestRun.error } : {}),
    };
  });
}

function findFailedStage(
  stages: Record<string, StageContext>,
): { stageId: string; error: string; iteration: number } | null {
  for (const [stageId, ctx] of Object.entries(stages)) {
    if (ctx.status === 'failed') {
      const lastRun = ctx.runs?.[ctx.runs.length - 1];
      const error = (lastRun?.error ?? 'Unknown error').slice(0, 500);
      const iteration = lastRun?.iteration ?? ctx.run_count ?? 1;
      return { stageId, error, iteration };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTestRunRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // -------------------------------------------------------------------------
  // GET /api/test-runs/:instanceId
  // -------------------------------------------------------------------------
  typedApp.get(
    '/api/test-runs/:instanceId',
    {
      schema: {
        params: z.object({ instanceId: z.string() }),
        querystring: z.object({ parentWorkflowId: z.string() }),
        tags: ['Test Runs'],
        summary: 'Get a snapshot of a single test-run instance',
      },
    },
    async (request, reply) => {
      try {
        const { instanceId } = request.params;
        const { parentWorkflowId } = request.query;

        if (!parentWorkflowId) {
          return reply.code(400).send({ error: 'parentWorkflowId query param is required' });
        }

        // Load the instance
        const instance = db.getInstance(instanceId);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });

        // Load the workflow definition
        if (!instance.definition_id) return reply.code(404).send({ error: 'Instance has no workflow definition' });
        const workflow = db.getWorkflow(instance.definition_id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow definition not found' });

        // Must be a test instance (is_test flag is on the instance row)
        if (!instance.is_test) {
          return reply.code(403).send({ error: 'not a test run' });
        }

        const wfParent = (workflow as WorkflowDefinition).parent_workflow_id;
        if (wfParent !== parentWorkflowId) {
          return reply.code(403).send({ error: 'parentWorkflowId mismatch' });
        }

        const stages = (instance.context as WorkflowContext)?.stages ?? {};
        const progress = computeProgress(stages);
        const stageSummary = buildStageSummary(stages);
        const failedStage = findFailedStage(stages);

        return {
          instanceId: instance.id,
          testWorkflowId: instance.definition_id,
          parentWorkflowId: (workflow as WorkflowDefinition).parent_workflow_id ?? null,
          status: instance.status as RunStatus,
          startedAt: instance.created_at,
          completedAt: instance.completed_at ?? null,
          progress,
          stageSummary,
          failedStage,
        };
      } catch (err) {
        console.error('[test-runs/snapshot] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/test-runs?parentWorkflowId=<id>&limit=<n>
  // -------------------------------------------------------------------------
  typedApp.get(
    '/api/test-runs',
    {
      schema: {
        querystring: z.object({
          parentWorkflowId: z.string(),
          limit: z.coerce.number().min(1).max(50).default(10).optional(),
        }),
        tags: ['Test Runs'],
        summary: 'List test-run instances for a parent workflow',
      },
    },
    async (request, reply) => {
      try {
        const { parentWorkflowId, limit = 10 } = request.query;

        // Find all test workflows for this parent
        const testWorkflows = db.listTestWorkflows();
        const childWorkflows = testWorkflows.filter(
          (w) => (w as WorkflowDefinition).parent_workflow_id === parentWorkflowId,
        );
        const childIds = new Set(childWorkflows.map((w) => w.id));

        if (childIds.size === 0) {
          return { data: [], total: 0 };
        }

        // Collect instances across all child workflows, sorted by created_at DESC
        const allInstances: Array<{
          instanceId: string;
          testWorkflowId: string;
          status: RunStatus;
          startedAt: string;
          completedAt?: string;
          failedStage?: { stageId: string; error: string; iteration: number } | null;
        }> = [];

        for (const wfId of childIds) {
          const { data: instances } = db.listInstances({
            definitionId: wfId,
            includeTest: true,
            limit: limit * 2,
          });
          for (const inst of instances) {
            if (!inst.definition_id) continue;
            const stages = (inst.context as WorkflowContext)?.stages ?? {};
            allInstances.push({
              instanceId: inst.id,
              testWorkflowId: inst.definition_id,
              status: inst.status as RunStatus,
              startedAt: inst.created_at,
              ...(inst.completed_at ? { completedAt: inst.completed_at } : {}),
              failedStage: findFailedStage(stages),
            });
          }
        }

        // Sort by startedAt DESC, trim to limit
        allInstances.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
        const total = allInstances.length;
        const data = allInstances.slice(0, limit);

        return { data, total };
      } catch (err) {
        console.error('[test-runs/list] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/internal/test-runs/cleanup
  // -------------------------------------------------------------------------
  typedApp.post(
    '/api/internal/test-runs/cleanup',
    {
      schema: {
        body: z.object({
          parentWorkflowId: z.string(),
          keep: z.number().int().nonnegative().optional(),
        }),
        tags: ['Internal'],
        summary: 'Delete old test workflows for a parent workflow, keeping the N most recent',
      },
    },
    async (request, reply) => {
      try {
        const { parentWorkflowId, keep = 3 } = request.body;
        const deleted = cleanupAuthorTestRuns(db, parentWorkflowId, keep);
        return { deleted };
      } catch (err) {
        console.error('[test-runs/cleanup] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
