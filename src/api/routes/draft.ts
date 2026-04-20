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
import { getDraft, saveDraft, mergePatch, resolveDraftId } from './shared.js';
import { broadcast } from '../websocket.js';
import { getValidAgentIds, validateAgentId } from './agent-utils.js';
import { validateStageConfig, validateGraphStructure, findUpstreamOutputSchema } from './validation.js';
import { errorMessage } from '../../utils/errors.js';
import { slugifyLabel } from '../../utils/slugify.js';
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
    const inputMode = stage.input_mode;
    const upstreamSchema = findUpstreamOutputSchema(draft, stage.id, inputMode);
    const diagnostics = validateCode({
      code: stageConfig.code as string,
      outputSchema: upstreamSchema,
      nodeType: stage.type,
      returnSchema: stageConfig.output_schema as Record<string, unknown> | undefined,
      sandbox: stageConfig.sandbox as boolean | undefined,
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
      const workflowId = resolveDraftId(request.params.workflowId);
      return getDraft(db, state.authorDrafts, workflowId);
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
      const workflowId = resolveDraftId(request.params.workflowId);
      return getDraft(db, state.authorDrafts, workflowId).stages || [];
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
      const workflowId = resolveDraftId(request.params.workflowId);
      const draft = getDraft(db, state.authorDrafts, workflowId);
      // draft operations work on loosely-typed objects; narrow only for validation calls
      const stage: Record<string, unknown> = { ...request.body };
      if (!stage.id) {
        const label = stage.label as string | undefined;
        const existingIds = new Set(draft.stages.map(s => s.id));
        if (label) {
          let base = slugifyLabel(label);
          if (!base) base = 'stage';
          let candidate = base;
          let counter = 2;
          while (existingIds.has(candidate)) {
            candidate = `${base}_${counter}`;
            counter++;
          }
          stage.id = candidate;
        } else {
          const type = (stage.type as string) || 'stage';
          const base = type.replace(/-/g, '_');
          let candidate = `${base}_1`;
          let counter = 1;
          while (existingIds.has(candidate)) {
            counter++;
            candidate = `${base}_${counter}`;
          }
          stage.id = candidate;
        }
      }
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
      saveDraft(db, state.authorDrafts, workflowId, draft);
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
      const { stageId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const { stageId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const { stageId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const { stageId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const workflowId = resolveDraftId(request.params.workflowId);
      return getDraft(db, state.authorDrafts, workflowId).edges || [];
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
      const workflowId = resolveDraftId(request.params.workflowId);
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
      if (!edge.id) edge.id = `edge_${edgeSource}_${edgeTarget}`;

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

      // Reject prompt_template on edges targeting non-agent nodes
      if (edge.prompt_template) {
        const targetStage = draft.stages.find((s) => s.id === edgeTarget);
        if (targetStage) {
          const targetSpec = nodeRegistry.get(targetStage.type);
          const inEdgeProps = (targetSpec?.inEdgeSchema as Record<string, unknown>)?.properties as Record<string, unknown> | undefined;
          const hasPromptTemplateField = inEdgeProps?.prompt_template;
          if (!hasPromptTemplateField) {
            return reply.status(400).send({
              error: `prompt_template is only supported on edges targeting agent nodes. Target "${edgeTarget}" is a ${targetStage.type}.`,
            });
          }
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
      const { edgeId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const { edgeId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const { edgeId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const idx = draft.edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) return reply.code(404).send({ error: `Edge "${edgeId}" not found` });
      const body = request.body;

      // Reject prompt_template on edges targeting non-agent nodes
      if (body.prompt_template) {
        const targetId = draft.edges[idx].target;
        const targetStage = draft.stages.find((s) => s.id === targetId);
        if (targetStage) {
          const targetSpec = nodeRegistry.get(targetStage.type);
          const inEdgeProps = (targetSpec?.inEdgeSchema as Record<string, unknown>)?.properties as Record<string, unknown> | undefined;
          const hasPromptTemplateField = inEdgeProps?.prompt_template;
          if (!hasPromptTemplateField) {
            return reply.status(400).send({
              error: `prompt_template is only supported on edges targeting agent nodes. Target "${targetId}" is a ${targetStage.type}.`,
            });
          }
        }
      }

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
      const { edgeId } = request.params;
      const workflowId = resolveDraftId(request.params.workflowId);
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
      const workflowId = resolveDraftId(request.params.workflowId);
      const draft = getDraft(db, state.authorDrafts, workflowId);
      const triggerConfig = request.body;

      // Map short provider aliases to canonical node type IDs.
      // Plugin-authored trigger types pass through as-is (e.g. 'my:kafka-trigger').
      const triggerTypeMap: Record<string, string> = {
        manual: 'manual-trigger',
        webhook: 'webhook-trigger',
        cron: 'cron-trigger',
        prompt: 'prompt-trigger',
      };
      const resolvedType = triggerTypeMap[triggerConfig.provider] ?? triggerConfig.provider;
      const spec = nodeRegistry.get(resolvedType);
      if (!spec) {
        return reply.code(400).send({ error: `Unknown trigger type: ${triggerConfig.provider}` });
      }
      if (spec.category !== 'trigger') {
        return reply.code(400).send({ error: `Node type '${resolvedType}' is not a trigger` });
      }
      const triggerType = resolvedType;

      // Find existing trigger stage (any trigger category)
      const existingIdx = draft.stages.findIndex((s) => nodeRegistry.isTriggerType(s.type));

      const triggerStage: Record<string, unknown> = {
        id: existingIdx >= 0 ? draft.stages[existingIdx].id : `trigger_${triggerConfig.provider}`,
        type: triggerType,
        label: spec.name || triggerType,
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
      const workflowId = resolveDraftId(request.params.workflowId);
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
        const workflowId = resolveDraftId(request.params.workflowId);
        const draft = getDraft(db, state.authorDrafts, workflowId);
        const body = (request.body || {}) as Record<string, unknown>;
        const payload = (body.payload || {}) as Record<string, unknown>;

        // Temporarily persist the draft to DB so the workflow can reference it
        const { id: _draftId, ...draftWithoutId } = draft;
        const testDef = deps.db.createWorkflow(
          { ...draftWithoutId, name: `[Test] ${draft.name}` },
          { isTest: true, parentWorkflowId: workflowId },
        );
        const testWorkflowId = testDef.id;

        // Create trigger event
        const event = deps.manualTrigger.trigger(payload);

        // Launch the test workflow instance
        const nonTriggerStageIds = testDef.stages
          .filter((s) => !nodeRegistry.isTriggerType(s.type))
          .map((s) => s.id);

        const { instance, validationError } = await launchWorkflow(
          deps.db,
          state.runner,
          testDef,
          event,
          nonTriggerStageIds,
          testWorkflowId,
          { isTest: true, initiatedBy: 'author' },
        );
        if (validationError) {
          return reply.code(422).send({ error: 'Payload validation failed', details: validationError });
        }

        // Notify the editor for this workflow so it can auto-open the test run viewer
        if (instance) {
          broadcast(
            'author:test_run_started',
            {
              workflowId,
              instanceId: instance.id,
              testWorkflowId: testDef.id,
              startedAt: instance.created_at,
            },
            { workflowId },
          );
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
      const workflowId = resolveDraftId(request.params.workflowId);
      const draft = getDraft(db, state.authorDrafts, workflowId);
      return validateWorkflow(draft);
    },
  );
}
