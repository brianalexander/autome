/**
 * Draft Sub-Resource API — Workflow Authoring Routes
 *
 * These routes provide a full CRUD API for editing workflow definitions in
 * draft (unpublished) state. They expose sub-resources of a workflow draft:
 * stages, edges, trigger configuration, and metadata.
 *
 * **Primary consumer**: The AI workflow author agent, which calls these
 * endpoints via the MCP server (`src/mcp/workflow-author-server.ts`).
 * The MCP server's `autome_api` tool maps directly to these routes.
 *
 * **Secondary consumers**: Any external API client that needs programmatic
 * access to workflow editing (e.g., CLI tools, CI/CD integrations, or
 * third-party orchestration layers).
 *
 * Endpoint groups (all prefixed with `/api/draft/:workflowId`):
 *
 *   Workflow:
 *     GET    /workflow                  — Full draft definition
 *
 *   Stages:
 *     GET    /stages                    — List all stages
 *     POST   /stages                    — Create a stage
 *     GET    /stages/:stageId           — Get a stage
 *     PUT    /stages/:stageId           — Replace a stage (full update)
 *     PATCH  /stages/:stageId           — Merge-patch a stage (partial update)
 *     DELETE /stages/:stageId           — Delete a stage and connected edges
 *
 *   Edges:
 *     GET    /edges                     — List all edges
 *     POST   /edges                     — Create an edge
 *     GET    /edges/:edgeId             — Get an edge
 *     PUT    /edges/:edgeId             — Replace an edge (full update)
 *     PATCH  /edges/:edgeId             — Merge-patch an edge (partial update)
 *     DELETE /edges/:edgeId             — Delete an edge
 *
 *   Trigger:
 *     PUT    /trigger                   — Set or update the workflow trigger
 *
 *   Metadata:
 *     PATCH  /metadata                  — Update workflow name/description
 *
 *   Test Run:
 *     POST   /test-run                  — Execute the draft as a test workflow
 */
import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { canReach } from '../../utils/graph.js';
import { launchWorkflow } from '../../workflow/launch.js';
import {
  CreateStageBodySchema,
  UpdateStageBodySchema,
  CreateEdgeBodySchema,
  UpdateEdgeBodySchema,
  UpdateTriggerBodySchema,
  UpdateMetadataBodySchema,
  type WorkflowDefinition,
  type StageDefinition,
  type EdgeDefinition,
} from '../../schemas/pipeline.js';
import type { RouteDeps, SharedState } from './shared.js';
import {
  getDraft,
  saveDraft,
  mergePatch,
  getValidAgentIds,
  validateAgentId,
  validateStageConfig,
  validateGraphStructure,
} from './shared.js';
import { errorMessage } from '../../utils/errors.js';
import { nodeRegistry } from '../../nodes/registry.js';
import { validateCode } from '../../api/validate-code.js';
import { validateWorkflow } from '../validate-workflow.js';

// Schemas for test-run
const TestRunBody = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** Returns graph validation warnings for a draft (never blocks — drafts are works in progress). */
function getDraftWarnings(draft: WorkflowDefinition): string[] {
  if (!draft.stages?.length && !draft.edges?.length) return [];
  const { warnings } = validateGraphStructure(draft.stages, draft.edges);
  return warnings;
}

/** Looks up the first upstream stage's output_schema for the given stage. */
function findUpstreamOutputSchema(
  draft: WorkflowDefinition,
  stageId: string,
): Record<string, unknown> | undefined {
  const incomingEdge = draft.edges?.find((e) => e.target === stageId);
  if (!incomingEdge) return undefined;
  const sourceStage = draft.stages?.find((s) => s.id === incomingEdge.source);
  const sourceConfig = sourceStage?.config as Record<string, unknown> | undefined;
  let schema = sourceConfig?.output_schema as Record<string, unknown> | undefined;
  if (!schema && sourceStage) {
    const spec = nodeRegistry.get(sourceStage.type);
    schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
  }
  return schema;
}

/**
 * After saving a stage, run code/expression validation and attach diagnostics
 * to the response if any issues are found.
 */
function autoValidateStage(
  draft: WorkflowDefinition,
  stage: StageDefinition,
): StageDefinition & { _validation?: { diagnostics: ReturnType<typeof validateCode>; isValid: boolean } } {
  const stageConfig = stage.config as Record<string, unknown> | undefined;

  if (stageConfig?.code && (stage.type === 'code-executor' || stage.type === 'code-trigger')) {
    const upstreamSchema = findUpstreamOutputSchema(draft, stage.id);
    const diagnostics = validateCode({
      code: stageConfig.code as string,
      outputSchema: upstreamSchema,
      nodeType: stage.type,
      returnSchema: stageConfig.output_schema as Record<string, unknown> | undefined,
    });
    if (diagnostics.length > 0) {
      return { ...stage, _validation: { diagnostics, isValid: false } };
    }
  }

  if (stageConfig?.expression && stage.type === 'transform') {
    const upstreamSchema = findUpstreamOutputSchema(draft, stage.id);
    const diagnostics = validateCode({
      code: stageConfig.expression as string,
      outputSchema: upstreamSchema,
      validationMode: 'expression',
    });
    if (diagnostics.length > 0) {
      return { ...stage, _validation: { diagnostics, isValid: false } };
    }
  }

  return stage;
}

export function registerDraftRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // GET /api/draft/:workflowId/workflow — full definition
  typedApp.get(
    '/api/draft/:workflowId/workflow',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        tags: ['Draft Workflow'],
        summary: 'Get the full draft workflow definition',
      },
    },
    async (request, reply) => {
      return getDraft(db, state.authorDrafts, request.params.workflowId);
    },
  );

  // GET /api/draft/:workflowId/stages
  typedApp.get(
    '/api/draft/:workflowId/stages',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        tags: ['Draft Stages'],
        summary: 'List all stages in the draft workflow',
      },
    },
    async (request, reply) => {
      return getDraft(db, state.authorDrafts, request.params.workflowId).stages || [];
    },
  );

  // POST /api/draft/:workflowId/stages — add stage
  typedApp.post(
    '/api/draft/:workflowId/stages',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        body: CreateStageBodySchema,
        tags: ['Draft Stages'],
        summary: 'Add a new stage to the workflow',
      },
    },
    async (request, reply) => {
      const draft = getDraft(db, state.authorDrafts, request.params.workflowId);
      // draft operations work on loosely-typed objects; narrow only for validation calls
      const stage: Record<string, unknown> = { ...request.body };
      if (!stage.id) stage.id = `stage-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (!stage.type) stage.type = 'agent';
      if (!stage.position) stage.position = { x: 250, y: 100 + draft.stages.length * 120 };
      // Validate stage config against node type schema
      const stageType = stage.type as string;
      const stageConfig = stage.config as Record<string, unknown> | undefined;
      if (stageType && !nodeRegistry.isTriggerType(stageType) && stageConfig) {
        const configErrors = validateStageConfig(stageType, stageConfig);
        if (configErrors.length > 0) {
          return reply.code(400).send({ error: configErrors.join('; '), validationErrors: configErrors });
        }
      }
      // Validate agentId if this is an agent stage
      const agentId = stageConfig?.agentId as string | undefined;
      if (stage.type === 'agent' && agentId) {
        const validIds = await getValidAgentIds();
        const err = validateAgentId(agentId, validIds);
        if (err) return reply.code(400).send({ error: err });
      }
      draft.stages.push(stage as unknown as StageDefinition);
      saveDraft(db, state.authorDrafts, request.params.workflowId, draft);
      const finalStage = autoValidateStage(draft, draft.stages[draft.stages.length - 1]);
      const warnings = getDraftWarnings(draft);
      return reply.code(201).send(warnings.length > 0 ? { ...finalStage, warnings } : finalStage);
    },
  );

  // GET /api/draft/:workflowId/stages/:stageId
  typedApp.get(
    '/api/draft/:workflowId/stages/:stageId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), stageId: z.string() }),
        tags: ['Draft Stages'],
        summary: 'Get a single stage by ID',
      },
    },
    async (request, reply) => {
      const { workflowId, stageId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const stage = draft.stages.find((s) => s.id === stageId);
      if (!stage) return reply.code(404).send({ error: `Stage "${stageId}" not found` });
      return stage;
    },
  );

  // PUT /api/draft/:workflowId/stages/:stageId — full replacement of a stage
  typedApp.put(
    '/api/draft/:workflowId/stages/:stageId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), stageId: z.string() }),
        body: UpdateStageBodySchema,
        tags: ['Draft Stages'],
        summary: 'Replace a stage (full update)',
      },
    },
    async (request, reply) => {
      const { workflowId, stageId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const idx = draft.stages.findIndex((s) => s.id === stageId);
      if (idx === -1) return reply.code(404).send({ error: `Stage "${stageId}" not found` });
      const body = request.body;
      // Validate stage config against node type schema
      const stageType = (body.type as string | undefined) || draft.stages[idx].type;
      const bodyConfig = body.config as Record<string, unknown> | null | undefined;
      if (stageType && !nodeRegistry.isTriggerType(stageType) && bodyConfig) {
        const configErrors = validateStageConfig(stageType, bodyConfig);
        if (configErrors.length > 0) {
          return reply.code(400).send({ error: configErrors.join('; '), validationErrors: configErrors });
        }
      }
      const newAgentId = bodyConfig?.agentId as string | undefined;
      if (newAgentId) {
        const validIds = await getValidAgentIds();
        const err = validateAgentId(newAgentId, validIds);
        if (err) return reply.code(400).send({ error: err });
      }
      // Preserve id and position if not provided
      draft.stages[idx] = { id: stageId, position: draft.stages[idx].position, ...body } as unknown as StageDefinition;
      saveDraft(db, state.authorDrafts, workflowId, draft);
      return autoValidateStage(draft, draft.stages[idx]);
    },
  );

  // PATCH /api/draft/:workflowId/stages/:stageId — RFC 7396 JSON Merge Patch
  typedApp.patch(
    '/api/draft/:workflowId/stages/:stageId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), stageId: z.string() }),
        body: UpdateStageBodySchema,
        tags: ['Draft Stages'],
        summary: 'Partially update a stage (JSON Merge Patch)',
      },
    },
    async (request, reply) => {
      const { workflowId, stageId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const idx = draft.stages.findIndex((s) => s.id === stageId);
      if (idx === -1) return reply.code(404).send({ error: `Stage "${stageId}" not found` });
      const existing = draft.stages[idx];
      const changes = request.body;
      // Validate merged config against node type schema
      const stageType = (changes.type as string | undefined) || existing.type;
      const changesConfig = changes.config as Record<string, unknown> | null | undefined;
      if (stageType && !nodeRegistry.isTriggerType(stageType) && changesConfig) {
        const mergedConfig = mergePatch(existing.config || {}, changesConfig);
        const configErrors = validateStageConfig(stageType, mergedConfig);
        if (configErrors.length > 0) {
          return reply.code(400).send({ error: configErrors.join('; '), validationErrors: configErrors });
        }
      }
      const newAgentId = changesConfig?.agentId as string | undefined;
      if (newAgentId) {
        const validIds = await getValidAgentIds();
        const err = validateAgentId(newAgentId, validIds);
        if (err) return reply.code(400).send({ error: err });
      }
      // RFC 7396: recursive merge, null deletes
      draft.stages[idx] = mergePatch(existing, changes);
      saveDraft(db, state.authorDrafts, workflowId, draft);
      return autoValidateStage(draft, draft.stages[idx]);
    },
  );

  // DELETE /api/draft/:workflowId/stages/:stageId — also removes connected edges
  typedApp.delete(
    '/api/draft/:workflowId/stages/:stageId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), stageId: z.string() }),
        tags: ['Draft Stages'],
        summary: 'Delete a stage and its connected edges',
      },
    },
    async (request, reply) => {
      const { workflowId, stageId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const before = draft.stages.length;
      draft.stages = draft.stages.filter((s) => s.id !== stageId);
      if (draft.stages.length === before) return reply.code(404).send({ error: `Stage "${stageId}" not found` });
      const edgesBefore = draft.edges.length;
      draft.edges = draft.edges.filter((e) => e.source !== stageId && e.target !== stageId);
      saveDraft(db, state.authorDrafts, workflowId, draft);
      const warnings = getDraftWarnings(draft);
      return { ok: true, removedEdges: edgesBefore - draft.edges.length, ...(warnings.length > 0 ? { warnings } : {}) };
    },
  );

  // GET /api/draft/:workflowId/edges
  typedApp.get(
    '/api/draft/:workflowId/edges',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        tags: ['Draft Edges'],
        summary: 'List all edges in the draft workflow',
      },
    },
    async (request, reply) => {
      return getDraft(db, state.authorDrafts, request.params.workflowId).edges || [];
    },
  );

  // POST /api/draft/:workflowId/edges — add edge
  typedApp.post(
    '/api/draft/:workflowId/edges',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        body: CreateEdgeBodySchema,
        tags: ['Draft Edges'],
        summary: 'Add a new edge to the workflow',
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const edge = { ...request.body } as Record<string, unknown>;
      // Normalize from/to → source/target
      if (!edge.source && edge.from) {
        edge.source = edge.from;
        delete edge.from;
      }
      if (!edge.target && edge.to) {
        edge.target = edge.to;
        delete edge.to;
      }
      if (!edge.source || !edge.target) return reply.code(400).send({ error: 'source and target are required' });
      const edgeSource = edge.source as string;
      const edgeTarget = edge.target as string;
      if (!edge.id) edge.id = `edge-${edgeSource}-${edgeTarget}`;

      // Detect if this edge creates a cycle — if target can reach source via existing edges
      const createsCycle = canReach(edgeTarget, edgeSource, draft.edges);

      if (createsCycle) {
        // Validate: cycle targets cannot use any_success trigger_rule (race condition risk)
        const targetStage = draft.stages.find((s) => s.id === edgeTarget);
        if (targetStage?.trigger_rule === 'any_success') {
          return reply.status(400).send({
            error: `Cannot create cycle edge to stage "${edgeTarget}" — stages with trigger_rule "any_success" cannot be cycle targets (race condition risk). Use "all_success" instead.`,
          });
        }
      }

      draft.edges.push(edge as unknown as EdgeDefinition);
      saveDraft(db, state.authorDrafts, workflowId, draft);
      const warnings = getDraftWarnings(draft);
      return reply.code(201).send(warnings.length > 0 ? { ...edge, warnings } : edge);
    },
  );

  // GET /api/draft/:workflowId/edges/:edgeId
  typedApp.get(
    '/api/draft/:workflowId/edges/:edgeId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), edgeId: z.string() }),
        tags: ['Draft Edges'],
        summary: 'Get a single edge by ID',
      },
    },
    async (request, reply) => {
      const { workflowId, edgeId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const edge = draft.edges.find((e) => e.id === edgeId);
      if (!edge) return reply.code(404).send({ error: `Edge "${edgeId}" not found` });
      return edge;
    },
  );

  // PUT /api/draft/:workflowId/edges/:edgeId — full replacement of an edge
  typedApp.put(
    '/api/draft/:workflowId/edges/:edgeId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), edgeId: z.string() }),
        body: UpdateEdgeBodySchema,
        tags: ['Draft Edges'],
        summary: 'Replace an edge (full update)',
      },
    },
    async (request, reply) => {
      const { workflowId, edgeId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const idx = draft.edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) return reply.code(404).send({ error: `Edge "${edgeId}" not found` });
      const body = request.body;

      draft.edges[idx] = {
        id: edgeId,
        source: draft.edges[idx].source,
        target: draft.edges[idx].target,
        ...body,
      } as unknown as EdgeDefinition;
      saveDraft(db, state.authorDrafts, workflowId, draft);
      return draft.edges[idx];
    },
  );

  // PATCH /api/draft/:workflowId/edges/:edgeId — RFC 7396 JSON Merge Patch
  typedApp.patch(
    '/api/draft/:workflowId/edges/:edgeId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), edgeId: z.string() }),
        body: UpdateEdgeBodySchema,
        tags: ['Draft Edges'],
        summary: 'Partially update an edge (JSON Merge Patch)',
      },
    },
    async (request, reply) => {
      const { workflowId, edgeId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const idx = draft.edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) return reply.code(404).send({ error: `Edge "${edgeId}" not found` });
      const body = request.body;
      draft.edges[idx] = mergePatch(draft.edges[idx], body);
      saveDraft(db, state.authorDrafts, workflowId, draft);
      return draft.edges[idx];
    },
  );

  // DELETE /api/draft/:workflowId/edges/:edgeId
  typedApp.delete(
    '/api/draft/:workflowId/edges/:edgeId',
    {
      schema: {
        params: z.object({ workflowId: z.string(), edgeId: z.string() }),
        tags: ['Draft Edges'],
        summary: 'Delete an edge',
      },
    },
    async (request, reply) => {
      const { workflowId, edgeId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const before = draft.edges.length;
      draft.edges = draft.edges.filter((e) => e.id !== edgeId);
      if (draft.edges.length === before) return reply.code(404).send({ error: `Edge "${edgeId}" not found` });
      saveDraft(db, state.authorDrafts, workflowId, draft);
      const warnings = getDraftWarnings(draft);
      return { ok: true, ...(warnings.length > 0 ? { warnings } : {}) };
    },
  );

  // PUT /api/draft/:workflowId/trigger — set/update trigger (creates trigger stage node)
  typedApp.put(
    '/api/draft/:workflowId/trigger',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        body: UpdateTriggerBodySchema,
        tags: ['Draft Trigger'],
        summary: 'Set or update the workflow trigger',
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const triggerConfig = request.body;

      // Map provider to specific trigger node type
      const triggerTypeMap: Record<string, string> = {
        manual: 'manual-trigger',
        webhook: 'webhook-trigger',
        cron: 'cron-trigger',
      };
      const triggerType = triggerTypeMap[triggerConfig.provider] || 'manual-trigger';
      const spec = nodeRegistry.get(triggerType);

      // Find existing trigger stage (any trigger category)
      const existingIdx = draft.stages.findIndex((s) => nodeRegistry.isTriggerType(s.type));

      const triggerStage: Record<string, unknown> = {
        id: existingIdx >= 0 ? draft.stages[existingIdx].id : `trigger-${Date.now()}`,
        type: triggerType,
        label: spec?.name || triggerType,
        config: {
          provider: triggerConfig.provider,
          ...(triggerConfig.filter ? { filter: triggerConfig.filter } : {}),
          ...(triggerConfig.webhook ? { webhook: triggerConfig.webhook } : {}),
        },
        position: existingIdx >= 0 ? draft.stages[existingIdx].position : { x: 0, y: 200 },
      };
      if (existingIdx >= 0) {
        draft.stages[existingIdx] = triggerStage as unknown as StageDefinition;
      } else {
        draft.stages.unshift(triggerStage as unknown as StageDefinition);
      }
      draft.trigger = { provider: triggerConfig.provider };
      saveDraft(db, state.authorDrafts, workflowId, draft);
      const warnings = getDraftWarnings(draft);
      return warnings.length > 0 ? { ...triggerStage, warnings } : triggerStage;
    },
  );

  // PATCH /api/draft/:workflowId/metadata — update name/description
  typedApp.patch(
    '/api/draft/:workflowId/metadata',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        body: UpdateMetadataBodySchema,
        tags: ['Draft Metadata'],
        summary: 'Update workflow name and/or description',
      },
    },
    async (request, reply) => {
      const { workflowId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const body = request.body;
      if (body.name !== undefined) draft.name = body.name;
      if (body.description !== undefined) draft.description = body.description;
      saveDraft(db, state.authorDrafts, workflowId, draft);
      return { ok: true, name: draft.name, description: draft.description };
    },
  );

  // POST /api/draft/:workflowId/test-run — Test run a draft workflow
  typedApp.post(
    '/api/draft/:workflowId/test-run',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
      },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        const draft = getDraft(db, state.authorDrafts, workflowId);
        const body = (request.body || {}) as Record<string, unknown>;
        const payload = (body.payload || {}) as Record<string, unknown>;

        // Temporarily persist the draft to DB so the workflow can reference it
        const { id: _draftId, ...draftWithoutId } = draft;
        const testDef = deps.db.createWorkflow({ ...draftWithoutId, name: `[Test] ${draft.name}` }, { isTest: true });
        const testWorkflowId = testDef.id;

        // Create trigger event
        const event = deps.manualTrigger.trigger(payload);

        // Launch the test workflow instance
        const nonTriggerStageIds = testDef.stages
          .filter((s) => !nodeRegistry.isTriggerType(s.type))
          .map((s) => s.id);

        const { instance, validationError } = await launchWorkflow(
          deps.db,
          testDef,
          event,
          nonTriggerStageIds,
          testWorkflowId,
          { isTest: true },
        );
        if (validationError) {
          return reply.code(422).send({ error: 'Payload validation failed', details: validationError });
        }

        return reply.code(201).send({ instance, testWorkflowId });
      } catch (err) {
        console.error('[test-run] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/draft/:workflowId/validate — comprehensive graph-level validation
  typedApp.get(
    '/api/draft/:workflowId/validate',
    {
      schema: {
        params: z.object({ workflowId: z.string() }),
        tags: ['Draft Validation'],
        summary: 'Validate the entire workflow graph — returns all errors, warnings, and code diagnostics',
      },
    },
    async (request) => {
      const { workflowId } = request.params;
      const draft = getDraft(db, state.authorDrafts, workflowId);
      return validateWorkflow(draft);
    },
  );
}
