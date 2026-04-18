import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { broadcast } from '../websocket.js';
import { discoverAgents } from '../../agents/discovery.js';
import type { RouteDeps, SharedState } from './shared.js';
import { getDraft, saveDraft, registerDraftAlias, resolveDraftId } from './shared.js';
import { wireAcpEvents, sendChatMessage } from './agent-utils.js';
import { buildAuthorSessionConfig } from './author-session-config.js';
import { errorMessage } from '../../utils/errors.js';
import { nodeRegistry } from '../../nodes/registry.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';
import { flushPendingAuthorMessages } from '../../author/message-injector.js';

// Zod schemas

const AuthorDraftBody = z.record(z.string(), z.unknown());

const AuthorChatBody = z.object({
  workflowId: z.string(),
  message: z.string(),
  definition: z.record(z.string(), z.unknown()).optional(),
});

const AuthorStopBody = z.object({
  workflowId: z.string(),
});

const AuthorSegmentsMigrateBody = z.object({
  fromId: z.string(),
  toId: z.string(),
});

export function registerAuthorRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // GET /api/internal/author-draft/:workflowId — Get current draft or saved workflow
  typedApp.get(
    '/api/internal/author-draft/:workflowId',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      const workflowId = resolveDraftId(request.params.workflowId);
      return getDraft(db, state.authorDrafts, workflowId);
    },
  );

  // PUT /api/internal/author-draft/:workflowId — Store draft and broadcast to frontend
  typedApp.put(
    '/api/internal/author-draft/:workflowId',
    {
      schema: { params: z.object({ workflowId: z.string() }), body: AuthorDraftBody },
    },
    async (request, reply) => {
      const workflowId = resolveDraftId(request.params.workflowId);
      const draft = request.body;
      saveDraft(db, state.authorDrafts, workflowId, draft as unknown as WorkflowDefinition);
      return { ok: true };
    },
  );

  // DELETE /api/internal/author-draft/:workflowId — Clear draft after save
  typedApp.delete('/api/internal/author-draft/:workflowId', {
    schema: { params: z.object({ workflowId: z.string() }) },
  }, async (request) => {
    const workflowId = resolveDraftId(request.params.workflowId);
    state.authorDrafts.delete(workflowId);
    deps.db.deleteDraft(workflowId);
    return { deleted: true };
  });

  // POST /api/internal/author-segments/migrate — Migrate draft author segments to a new workflow ID
  typedApp.post(
    '/api/internal/author-segments/migrate',
    {
      schema: { body: AuthorSegmentsMigrateBody },
    },
    async (request, reply) => {
      try {
        const { fromId, toId } = request.body;
        const migrated = db.migrateAuthorSegments(fromId, toId);
        // Register alias so the author agent's MCP server transparently resolves
        // the temporary fromId to the real UUID when tool calls reference it
        registerDraftAlias(fromId, toId);
        db.registerDraftAlias(fromId, toId);
        // Also clean up the draft definition
        state.authorDrafts.delete(fromId);
        db.deleteDraft(fromId);
        return { ok: true, migrated };
      } catch (err) {
        console.error('[author-segments/migrate] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // =========================================================================
  // Author session endpoints
  // =========================================================================

  // Build author context: workflow state, available agents, OpenAPI spec
  async function buildAuthorContext(workflowId: string): Promise<string | null> {
    const workflow = state.authorDrafts.get(workflowId) || deps.db.getWorkflow(workflowId);
    let agents: Array<{ name: string; description?: string }> = [];
    try {
      const discovered = await discoverAgents();
      agents = discovered.map((a) => ({ name: a.name, description: a.spec.description }));
    } catch (err) {
      console.warn('[author-context] Agent discovery failed:', err);
    }

    const parts: string[] = [];
    parts.push(`<workflow_id>${workflowId}</workflow_id>`);
    parts.push('<current_workflow>');
    if (workflow) {
      parts.push(`Name: ${workflow.name || '(unnamed)'}`);
      parts.push(`Description: ${workflow.description || '(none)'}`);
      parts.push(`\nStages (${workflow.stages.length}):`);
      for (const s of workflow.stages) {
        const cfg = (s.config || {}) as Record<string, unknown>;
        const detail =
          s.type === 'agent'
            ? `agent: ${cfg.agentId || 'none'}${cfg.output_schema ? ', has output_schema' : ''}`
            : nodeRegistry.isTriggerType(s.type)
              ? `trigger: ${s.type}`
              : s.type === 'gate'
                ? `gate: ${cfg.type || 'manual'}`
                : s.type;
        parts.push(`  - ${s.id} (${detail})`);
      }
      parts.push(`\nEdges (${workflow.edges.length}):`);
      for (const e of workflow.edges) {
        let desc = `  - ${e.source} -> ${e.target}`;
        if (e.label) desc += ` [${e.label}]`;
        if (e.condition) desc += ` condition: ${e.condition}`;
        parts.push(desc);
        if (e.prompt_template) {
          parts.push(
            `    prompt_template: ${e.prompt_template.length > 120 ? e.prompt_template.slice(0, 120) + '...' : e.prompt_template}`,
          );
        }
        const sourceStage = workflow.stages.find((s) => s.id === e.source);
        if (sourceStage) {
          parts.push(`    template vars: {{ output.<field> }} = ${e.source}'s output`);
        }
        const upstreamIds = workflow.stages
          .filter((s) => !nodeRegistry.isTriggerType(s.type) && s.id !== e.target)
          .map((s) => s.id);
        if (upstreamIds.length > 0) {
          const examples = upstreamIds
            .slice(0, 3)
            .map((id: string) =>
              /^[a-zA-Z_]\w*$/.test(id) ? `stages.${id}.output.<field>` : `stages['${id}'].output.<field>`,
            );
          parts.push(`    also available: ${examples.join(', ')}`);
        }
      }
    } else {
      parts.push('(empty workflow — no stages or edges yet)');
    }
    parts.push('</current_workflow>');

    parts.push('<available_agents>');
    for (const a of agents) {
      parts.push(`  - ${a.name}${a.description ? `: ${a.description}` : ''}`);
    }
    parts.push('</available_agents>');

    // Surface available secret names (never values) so the agent can reference
    // them when generating code nodes or templated configs.
    if (deps.secretsService) {
      const secretList = deps.secretsService.list();
      parts.push('<available_secrets>');
      if (secretList.length === 0) {
        parts.push('(none — users can add secrets in Settings → Secrets)');
      } else {
        for (const s of secretList) {
          parts.push(`  - ${s.name}${s.description ? `: ${s.description}` : ''}`);
        }
        parts.push(
          'Reference secrets by name, never hardcode values:',
          '  - In code nodes:      const token = context.secrets.JIRA_TOKEN;',
          '  - In templated config: {{ secret(\'JIRA_TOKEN\') }}',
          'Secret values are never serialized into workflow JSON.',
        );
      }
      parts.push('</available_secrets>');
    }

    // Include OpenAPI spec on first message of the session
    // Emit autonomous testing setting
    const autoTestEnabled = !!(workflow as WorkflowDefinition)?.authoring?.auto_test;
    parts.push(`Autonomous testing: ${autoTestEnabled ? 'enabled' : 'disabled'}`);

    if (!state.authorSpecSent.has(workflowId)) {
      const fullSpec = app.swagger();
      const draftSpec = {
        ...fullSpec,
        paths: Object.fromEntries(
          Object.entries(fullSpec.paths || {}).filter(
            ([p]) => p.startsWith('/api/draft/') && !p.includes('/test-run'),
          ),
        ),
      };
      parts.push('<openapi_spec>');
      parts.push(JSON.stringify(draftSpec, null, 2));
      parts.push('</openapi_spec>');

      // Include node type registry — config schemas, defaults, and edge schemas for each type
      const nodeTypes = nodeRegistry.getAllInfo().map((nt) => ({
        id: nt.id,
        name: nt.name,
        category: nt.category,
        description: nt.description,
        configSchema: nt.configSchema,
        defaultConfig: nt.defaultConfig,
        inEdgeSchema: nt.inEdgeSchema,
        outEdgeSchema: nt.outEdgeSchema,
      }));
      parts.push('<node_types>');
      parts.push(JSON.stringify(nodeTypes, null, 2));
      parts.push('</node_types>');

      state.authorSpecSent.add(workflowId);
    }

    return parts.join('\n');
  }

  const authorSessionConfig = (workflowId: string) =>
    buildAuthorSessionConfig(state.authorPool, workflowId);

  // POST /api/author/chat — Send a message to the author AI
  typedApp.post(
    '/api/author/chat',
    {
      schema: { body: AuthorChatBody },
    },
    async (request, reply) => {
      try {
        const { workflowId, message, definition } = request.body;

        // Sync current canvas state so the AI Author sees unsaved changes
        if (definition) {
          saveDraft(db, state.authorDrafts, workflowId, definition as unknown as WorkflowDefinition);
        }

        await sendChatMessage(
          {
            config: authorSessionConfig(workflowId),
            message,
            buildContext: () => buildAuthorContext(workflowId),
          },
          db,
        );

        return { ok: true };
      } catch (err) {
        console.error('[author/chat] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/author/stop — Cancel the current author turn (session stays alive)
  typedApp.post(
    '/api/author/stop',
    {
      schema: { body: AuthorStopBody },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.body;

        const client = state.authorPool.getClient('author', workflowId);
        if (client) {
          client.cancel();
        }

        broadcast('author:cancelled', { workflowId }, { workflowId });
        return { stopped: true };
      } catch (err) {
        console.error('[author/stop] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/author/:workflowId/segments — Load persisted author chat segments
  typedApp.get(
    '/api/author/:workflowId/segments',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        return db.getSegments('author', workflowId, 1);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // DELETE /api/author/:workflowId/segments — Clear author chat history
  typedApp.delete(
    '/api/author/:workflowId/segments',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        db.deleteSegments('author', workflowId, 1);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/author/:workflowId/restart-session — Destroy session, next message spawns fresh
  typedApp.post(
    '/api/author/:workflowId/restart-session',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        // Kill the process
        await state.authorPool.terminate('author', workflowId);
        // Clear stored session ID so next message doesn't try to resume
        const sessionKey = `author:${workflowId}`;
        db.markAcpSessionStatus(sessionKey, 'destroyed');
        // Clear chat history so next message starts fresh
        db.deleteSegments('author', workflowId);
        // Reset spec flag so full context is re-sent
        state.authorSpecSent.delete(workflowId);
        broadcast('author:session_status', { workflowId, status: 'pending_restart' }, { workflowId });
        return { ok: true };
      } catch (err) {
        console.error('[author/restart-session] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/author/:workflowId/clear-chat — Kill session + wipe history for a fresh start
  typedApp.post(
    '/api/author/:workflowId/clear-chat',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        // Kill the process
        await state.authorPool.terminate('author', workflowId);
        // Clear stored session
        const sessionKey = `author:${workflowId}`;
        db.markAcpSessionStatus(sessionKey, 'destroyed');
        // Reset spec flag so full context is re-sent
        state.authorSpecSent.delete(workflowId);
        // Clear all chat history
        db.deleteSegments('author', workflowId, 1);
        broadcast('author:session_status', { workflowId, status: 'cleared' }, { workflowId });
        return { ok: true };
      } catch (err) {
        console.error('[author/clear-chat] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/session-info/:key — Return stored session metadata (model, status)
  typedApp.get(
    '/api/session-info/:key',
    async (request) => {
      const { key } = request.params as { key: string };
      const session = db.getAcpSession(key);
      return { model: session?.model_name || null, status: session?.status || null };
    },
  );

  // POST /api/author/pending-messages/:workflowId/flush — Flush pending author messages
  typedApp.post(
    '/api/author/pending-messages/:workflowId/flush',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        const messages = flushPendingAuthorMessages({ db }, workflowId);
        return { messages };
      } catch (err) {
        console.error('[author/pending-messages/flush] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
