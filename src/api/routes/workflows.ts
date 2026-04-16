import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createReadStream } from 'fs';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { launchWorkflow } from '../../workflow/launch.js';
import { WorkflowDefinitionSchema } from '../../schemas/pipeline.js';
import type { RouteDeps, SharedState } from './shared.js';
import { validateAllStagesConfig, validateGraphStructure } from './validation.js';
import { errorMessage } from '../../utils/errors.js';
import { exportWorkflow } from '../../bundle/export.js';
import { importWorkflow, previewBundle } from '../../bundle/import.js';
import { BUNDLE_EXTENSION } from '../../bundle/types.js';
import { checkWorkflowHealth } from '../../bundle/health.js';
import { activateWorkflowTriggers, createTriggerSubscriptions, deactivateWorkflowTriggers } from '../../engine/trigger-lifecycle.js';

// Zod schemas for workflow routes
const WorkflowIdParams = z.object({ id: z.string() });

const PaginationQuery = z.object({
  limit: z.coerce.number().min(1).max(200).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});

const CreateWorkflowBody = z
  .object({
    name: z.string(),
    trigger: z.object({
      provider: z.string(),
      filter: z.record(z.string(), z.unknown()).optional(),
    }),
    stages: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    active: z.boolean().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const UpdateWorkflowBody = z.record(z.string(), z.unknown());

const TriggerBody = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  typedApp.get(
    '/api/workflows',
    {
      schema: { querystring: PaginationQuery },
    },
    async (request, reply) => {
      try {
        const { limit, offset } = request.query;
        const result = db.listWorkflows({ limit, offset });
        return { data: result.data, total: result.total, limit: limit ?? 50, offset: offset ?? 0 };
      } catch (err) {
        console.error('GET /api/workflows error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  typedApp.post(
    '/api/workflows',
    {
      schema: { body: CreateWorkflowBody },
    },
    async (request, reply) => {
      try {
        const body = request.body;
        if (!body.name || !body.trigger || !body.stages || !body.edges) {
          return reply.code(400).send({ error: 'Missing required fields: name, trigger, stages, edges' });
        }
        // Validate stage configs against their node type schemas
        const configErrors = validateAllStagesConfig(
          body.stages as Array<{ type?: string; config?: Record<string, unknown> }>,
        );
        if (configErrors.length > 0) {
          return reply.code(400).send({ error: configErrors.join('; '), validationErrors: configErrors });
        }
        // Validate graph structure (edge refs, trigger presence, reachability)
        const graphResult = validateGraphStructure(
          body.stages as Array<{ id: string; type: string }>,
          body.edges as Array<{ source: string; target: string }>,
        );
        if (graphResult.errors.length > 0) {
          return reply.code(400).send({
            error: graphResult.errors.join('; '),
            validationErrors: graphResult.errors,
            warnings: graphResult.warnings,
          });
        }
        // Default active to false if not provided
        const workflowData = { ...body, active: body.active ?? false };
        const workflow = db.createWorkflow(workflowData as Parameters<typeof db.createWorkflow>[0]);
        return reply
          .code(201)
          .send({ ...workflow, warnings: graphResult.warnings.length > 0 ? graphResult.warnings : undefined });
      } catch (err) {
        console.error('POST /api/workflows error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  typedApp.get(
    '/api/workflows/:id',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const workflow = db.getWorkflow(id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
        return workflow;
      } catch (err) {
        console.error('GET /api/workflows/:id error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  typedApp.put(
    '/api/workflows/:id',
    {
      schema: { params: WorkflowIdParams, body: UpdateWorkflowBody },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const existing = db.getWorkflow(id);
        if (!existing) return reply.code(404).send({ error: 'Workflow not found' });
        // Validate stage configs if stages are being updated
        const body = request.body as Record<string, unknown>;
        if (body.stages && Array.isArray(body.stages)) {
          const configErrors = validateAllStagesConfig(
            body.stages as Array<{ type?: string; config?: Record<string, unknown> }>,
          );
          if (configErrors.length > 0) {
            return reply.code(400).send({ error: configErrors.join('; '), validationErrors: configErrors });
          }
        }
        if (body.stages || body.edges) {
          // Validate graph structure whenever stages or edges are updated
          const stages = (body.stages as Array<{ id: string; type: string }> | undefined) ?? existing.stages ?? [];
          const edges = (body.edges as unknown[] | undefined) ?? existing.edges ?? [];
          const graphResult = validateGraphStructure(
            stages as Array<{ id: string; type: string }>,
            edges as Array<{ source: string; target: string }>,
          );
          if (graphResult.errors.length > 0) {
            return reply.code(400).send({
              error: graphResult.errors.join('; '),
              validationErrors: graphResult.errors,
              warnings: graphResult.warnings,
            });
          }
          const updated = db.updateWorkflow(id, request.body);
          return { ...updated, warnings: graphResult.warnings.length > 0 ? graphResult.warnings : undefined };
        }
        const updated = db.updateWorkflow(id, request.body);
        return updated;
      } catch (err) {
        console.error('PUT /api/workflows/:id error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  typedApp.delete(
    '/api/workflows/:id',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const existing = db.getWorkflow(id);
        if (!existing) {
          return reply.code(404).send({ error: 'Workflow not found' });
        }

        // Cancel any running instances before deleting to avoid orphaned agent processes.
        const { data: instances } = deps.db.listInstances({ definitionId: id });
        const runningInstances = instances.filter((i) =>
          ['running', 'waiting_gate', 'waiting_input'].includes(i.status),
        );

        for (const instance of runningInstances) {
          const instanceId = instance.id;

          // Kill all agent processes for every stage in this instance
          const stageIds = Object.keys(instance.context?.stages || {});
          for (const stageId of stageIds) {
            const client = state.acpPool.getClient(instanceId, stageId);
            if (client) {
              client.cancel();
              await state.acpPool.terminate(instanceId, stageId);
            }
          }

          // Cancel the runner (aborts in-memory execution — best-effort)
          await state.runner.cancel(instanceId).catch((err) => {
            console.warn(`[delete-workflow] Could not cancel runner workflow ${instanceId}:`, err);
          });

          // Mark the instance as cancelled in the DB
          try {
            deps.db.updateInstance(instanceId, {
              status: 'cancelled',
              completed_at: new Date().toISOString(),
            });
          } catch (dbErr) {
            console.warn(`[delete-workflow] Could not update instance ${instanceId}:`, dbErr);
          }
        }

        db.deleteWorkflow(id);

        // Also clean up any draft (memory cache and DB)
        state.authorDrafts.delete(id);
        db.deleteDraft(id);
        return reply.code(204).send();
      } catch (err) {
        console.error('DELETE /api/workflows/:id error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/workflows/:id/trigger — Manually trigger a workflow
  typedApp.post(
    '/api/workflows/:id/trigger',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const workflow = deps.db.getWorkflow(id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

        // Create the trigger event via manual provider
        const body = (request.body || {}) as Record<string, unknown>;
        const event = deps.manualTrigger.trigger((body.payload || {}) as Record<string, unknown>);

        const allStageIds = workflow.stages.map((s) => s.id);
        const { instance, runnerError, validationError } = await launchWorkflow(
          deps.db,
          state.runner,
          workflow,
          event,
          allStageIds,
          workflow.id,
        );
        if (validationError) {
          return reply.code(422).send({ error: 'Payload validation failed', details: validationError });
        }
        if (runnerError) {
          console.error('[trigger] Runner error:', runnerError);
        }

        return reply.code(201).send(instance);
      } catch (err) {
        console.error('[trigger] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/workflows/:id/versions — List version history
  typedApp.get(
    '/api/workflows/:id/versions',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const workflow = db.getWorkflow(id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
        const versions = db.listWorkflowVersions(id);
        // Return lightweight list: version number, created_at, name/description (not full definition)
        return versions.map((v) => ({
          version: v.version,
          created_at: v.created_at,
          name: v.definition.name,
          description: v.definition.description,
        }));
      } catch (err) {
        console.error('GET /api/workflows/:id/versions error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/workflows/:id/versions/:version — Get full definition for a specific version
  typedApp.get(
    '/api/workflows/:id/versions/:version',
    {
      schema: { params: z.object({ id: z.string(), version: z.coerce.number() }) },
    },
    async (request, reply) => {
      try {
        const { id, version } = request.params;
        const def = db.getWorkflowVersion(id, version);
        if (!def) return reply.code(404).send({ error: 'Version not found' });
        return def;
      } catch (err) {
        console.error('GET /api/workflows/:id/versions/:version error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/workflows/:id/clone — Clone a workflow
  typedApp.post(
    '/api/workflows/:id/clone',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const source = db.getWorkflow(id);
        if (!source) return reply.code(404).send({ error: 'Workflow not found' });

        const { id: _sourceId, version: _version, ...rest } = source;
        const cloned = db.createWorkflow({
          ...rest,
          name: `${source.name} (Copy)`,
          active: false,
        });

        db.copyAuthorSegments(id, cloned.id);

        return reply.code(201).send(cloned);
      } catch (err) {
        console.error('POST /api/workflows/:id/clone error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/workflows/:id/activate — Start listening for trigger events
  typedApp.post(
    '/api/workflows/:id/activate',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const workflow = deps.db.getWorkflow(id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

        deps.db.updateWorkflow(id, { active: true });

        // Remove any existing subscriptions first to prevent duplicates from
        // repeated activate/deactivate cycles.
        deps.eventBus.removeSubscriptionsForWorkflow(workflow.id);

        createTriggerSubscriptions(workflow, deps.eventBus);

        // Start trigger executor processes (code-trigger, cron, etc.)
        await activateWorkflowTriggers(workflow);

        return { activated: true, workflowId: workflow.id };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/workflows/:id/deactivate
  typedApp.post(
    '/api/workflows/:id/deactivate',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const workflow = deps.db.getWorkflow(id);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

        deps.db.updateWorkflow(id, { active: false });
        deps.eventBus.removeSubscriptionsForWorkflow(workflow.id);
        deactivateWorkflowTriggers(workflow.id);

        return { deactivated: true, workflowId: workflow.id };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // =========================================================================
  // Bundle import / export
  // =========================================================================

  // POST /api/workflows/:id/export — export workflow as .autome bundle
  typedApp.post(
    '/api/workflows/:id/export',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      const { id } = request.params;
      const workflow = db.getWorkflow(id);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      try {
        const { archivePath, bundle, warnings } = await exportWorkflow(workflow);

        const filename = `${workflow.name.replace(/[^a-zA-Z0-9_-]/g, '_')}${BUNDLE_EXTENSION}`;
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        reply.header('Content-Type', 'application/json');
        // Surface any export warnings (e.g. missing agents) via a header so the
        // caller can display them alongside the download without altering the body.
        if (warnings.length > 0) {
          reply.header('X-Export-Warnings', JSON.stringify(warnings));
        }
        reply.raw.on('finish', () => { unlink(archivePath).catch(() => {}); });
        return reply.send(createReadStream(archivePath));
      } catch (err) {
        console.error('[export] Failed:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/workflows/import — import a .autome bundle
  app.post('/api/workflows/import', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      const force = (request.query as Record<string, string>).force === 'true';

      // Write to temp file
      const tempPath = join(process.cwd(), 'data', `_upload-${Date.now()}${BUNDLE_EXTENSION}`);
      await mkdir(join(process.cwd(), 'data'), { recursive: true });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      await writeFile(tempPath, Buffer.concat(chunks));

      try {
        const result = await importWorkflow(tempPath, db, { force });
        return result;
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    } catch (err) {
      console.error('[import] Failed:', err);
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // POST /api/workflows/import/preview — preview a bundle without importing
  app.post('/api/workflows/import/preview', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.code(400).send({ error: 'No file uploaded' });

      const tempPath = join(process.cwd(), 'data', `_preview-${Date.now()}${BUNDLE_EXTENSION}`);
      await mkdir(join(process.cwd(), 'data'), { recursive: true });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      await writeFile(tempPath, Buffer.concat(chunks));

      try {
        const result = await previewBundle(tempPath);
        return result;
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    } catch (err) {
      console.error('[import/preview] Failed:', err);
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/workflows/:id/bundle-info — bundle info (bundles are no longer stored on disk)
  typedApp.get(
    '/api/workflows/:id/bundle-info',
    {
      schema: { params: WorkflowIdParams },
    },
    async (_request, _reply) => {
      return { hasBundle: false };
    },
  );

  // GET /api/workflows/:id/health — check all external dependencies
  typedApp.get(
    '/api/workflows/:id/health',
    {
      schema: { params: WorkflowIdParams },
    },
    async (request, reply) => {
      const { id } = request.params;
      const workflow = db.getWorkflow(id);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      try {
        const result = await checkWorkflowHealth(workflow, { workflowId: id });
        return result;
      } catch (err) {
        console.error('[health] Check failed:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
