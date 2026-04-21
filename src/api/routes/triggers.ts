/**
 * Trigger observability endpoints (Phase 4).
 *
 * GET /api/workflows/:id/triggers
 *   Returns status + log preview for all active triggers on a workflow.
 *
 * GET /api/workflows/:id/triggers/:stageId/logs?limit=200
 *   Returns the full log buffer for a specific trigger stage.
 */
import type { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';
import {
  getWorkflowTriggerStatuses,
  getTriggerLogs,
} from '../../engine/trigger-lifecycle.js';
import {
  TriggerStatusesResponseSchema,
  TriggerLogsResponseSchema,
} from '../../schemas/pipeline.js';

const ErrorResponseSchema = z.object({ error: z.string() });

const WorkflowIdParams = z.object({ id: z.string() });
const TriggerStageParams = z.object({ id: z.string(), stageId: z.string() });
const LogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200).optional(),
});

export function registerTriggerObservabilityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // GET /api/workflows/:id/triggers
  typedApp.get(
    '/api/workflows/:id/triggers',
    {
      schema: {
        params: WorkflowIdParams,
        response: { 200: TriggerStatusesResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const workflow = db.getWorkflow(id);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      const triggers = getWorkflowTriggerStatuses(id);
      return { triggers };
    },
  );

  // GET /api/workflows/:id/triggers/:stageId/logs
  typedApp.get(
    '/api/workflows/:id/triggers/:stageId/logs',
    {
      schema: {
        params: TriggerStageParams,
        querystring: LogsQuerySchema,
        response: { 200: TriggerLogsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, stageId } = request.params;
      const workflow = db.getWorkflow(id);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      const limit = request.query.limit ?? 200;
      const lines = getTriggerLogs(id, stageId, limit);
      return { lines };
    },
  );
}
