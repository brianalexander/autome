import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { join } from 'path';
import { broadcast } from '../websocket.js';
import { config as appConfig } from '../../config.js';
import * as restateClient from '../../restate/client.js';
import { discoverAgents } from '../../agents/discovery.js';
import type { RouteDeps, SharedState, SessionConfig } from './shared.js';
import { wireAcpEvents, sendChatMessage, getDraft, saveDraft, buildConversationHistory } from './shared.js';
import { errorMessage } from '../../utils/errors.js';
import { nodeRegistry } from '../../nodes/registry.js';
import type { WorkflowInstance } from '../../types/instance.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';
import { createProviderAsync } from '../../acp/provider/registry.js';
import { validateCode } from '../validate-code.js';

// Zod schemas for internal routes
const SpawnAgentBody = z.object({
  instanceId: z.string(),
  stageId: z.string(),
  iteration: z.number().optional(),
  agentId: z.string(),
  prompt: z.string(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  /** Workflow definition ID — enables workflow-scoped agent discovery for imported bundles. */
  definitionId: z.string().optional(),
  /** Optional ACP provider override for this spawn (stage or workflow level). */
  acpProvider: z.string().optional(),
  /** Timeout in minutes after which the agent is killed and stage is marked failed. */
  timeout_minutes: z.number().positive().optional(),
});

const KillAgentBody = z.object({
  instanceId: z.string(),
  stageId: z.string(),
});

const WorkflowSignalBody = z.object({
  instanceId: z.string(),
  stageId: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  prompt: z.string().optional(),
});

const ContextSyncBody = z.object({
  instanceId: z.string(),
  context: z.unknown(),
  status: z.string().optional(),
  currentStageIds: z.array(z.string()).optional(),
});

const WorkflowFinishedBody = z.object({
  instanceId: z.string(),
  status: z.string(),
  context: z.unknown().optional(),
  error: z.string().optional(),
});

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

const ValidateCodeBody = z.object({
  code: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  nodeType: z.string().optional(),
});

const WorkflowStatusBody = z.object({
  instanceId: z.string(),
  stageId: z.string(),
  status: z.string(),
  message: z.string().optional(),
  /** Gate timeout in minutes (only meaningful for status="waiting_gate"). */
  timeout_minutes: z.number().positive().optional(),
  /** Action on timeout: "approve" or "reject" (default: "reject"). */
  timeout_action: z.enum(['approve', 'reject']).optional(),
});

/** Clear any active timeout for a stage and remove it from the map. */
function clearStageTimeout(stageTimeouts: Map<string, ReturnType<typeof setTimeout>>, key: string): void {
  const existing = stageTimeouts.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    stageTimeouts.delete(key);
  }
}

export function registerInternalRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // POST /api/internal/workflow-signal — Unified agent->orchestrator signal
  typedApp.post(
    '/api/internal/workflow-signal',
    {
      schema: { body: WorkflowSignalBody },
    },
    async (request, reply) => {
      try {
        const { instanceId, stageId, status, output, error: errorMsg, message, prompt } = request.body;
        const key = `${instanceId}:${stageId}`;

        switch (status) {
          case 'completed':
            // Cancel any pending timeout — stage completed normally
            clearStageTimeout(state.stageTimeouts, key);
            await restateClient.signalStageComplete(instanceId, stageId, output);
            broadcast('instance:stage_completed', { instanceId, stageId, output }, { instanceId });
            state.signalledStages.add(key);
            return { ok: true, message: 'Stage completed successfully. Output has been recorded.' };

          case 'failed':
            // Cancel any pending timeout — stage already failed
            clearStageTimeout(state.stageTimeouts, key);
            await restateClient.signalStageFailed(instanceId, stageId, errorMsg || 'Agent signalled failure');
            broadcast('instance:stage_failed', { instanceId, stageId, error: errorMsg }, { instanceId });
            state.signalledStages.add(key);
            return { ok: true, message: 'Stage marked as failed.' };

          case 'in_progress':
            broadcast(
              'agent:status',
              { instanceId, stageId, status: message || 'in_progress', message },
              { instanceId },
            );
            return { ok: true, message: 'Status updated.' };

          case 'waiting_input':
            broadcast('agent:input_requested', { instanceId, stageId, prompt }, { instanceId });
            return { ok: true, message: 'Input request broadcast. Waiting for human response.' };

          default:
            return reply.code(400).send({
              error: `Unknown status: ${status}. Must be one of: completed, failed, in_progress, waiting_input`,
            });
        }
      } catch (err) {
        console.error('[workflow-signal] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/internal/workflow-status — Gate and stage status broadcasts (with optional timeout scheduling)
  typedApp.post(
    '/api/internal/workflow-status',
    {
      schema: { body: WorkflowStatusBody },
    },
    async (request, reply) => {
      try {
        const { instanceId, stageId, status, message, timeout_minutes, timeout_action } = request.body;
        const key = `${instanceId}:${stageId}`;

        broadcast('instance:stage_status', { instanceId, stageId, status, message }, { instanceId });

        // Schedule a gate timeout if requested
        if (status === 'waiting_gate' && timeout_minutes != null) {
          // Clear any pre-existing timer for this key (e.g. from a prior iteration)
          clearStageTimeout(state.stageTimeouts, key);

          const timeoutMs = timeout_minutes * 60 * 1000;
          const action = timeout_action ?? 'reject';

          console.log(`[gate-timeout] Scheduling ${action} for ${key} in ${timeout_minutes}m`);

          const handle = setTimeout(async () => {
            state.stageTimeouts.delete(key);
            console.log(`[gate-timeout] Timeout fired for ${key} — applying action: ${action}`);
            try {
              if (action === 'approve') {
                await restateClient.approveGate(instanceId, stageId);
                broadcast('instance:gate_approved', { instanceId, stageId, reason: 'timeout' }, { instanceId });
              } else {
                await restateClient.rejectGate(
                  instanceId,
                  stageId,
                  `Gate timed out after ${timeout_minutes} minute(s)`,
                );
                broadcast(
                  'instance:gate_rejected',
                  { instanceId, stageId, reason: `Gate timed out after ${timeout_minutes} minute(s)` },
                  { instanceId },
                );
              }
            } catch (err) {
              console.error(`[gate-timeout] Failed to ${action} gate ${key}:`, errorMessage(err));
            }
          }, timeoutMs);

          state.stageTimeouts.set(key, handle);
        }

        return { ok: true };
      } catch (err) {
        console.error('[workflow-status] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/internal/workflow-context-sync
  typedApp.post(
    '/api/internal/workflow-context-sync',
    {
      schema: { body: ContextSyncBody },
    },
    async (request, reply) => {
      try {
        const { instanceId, context, status, currentStageIds } = request.body;

        // Guard: if the instance was deleted (e.g. workflow deletion raced with a
        // Restate callback), silently ignore rather than erroring — the workflow
        // is already gone and there's nothing meaningful to update.
        const existing = deps.db.getInstance(instanceId);
        if (!existing) {
          return reply.status(200).send({ ignored: true, reason: 'instance_deleted' });
        }

        deps.db.updateInstance(instanceId, {
          context: context as WorkflowInstance['context'],
          ...(status ? { status: status as WorkflowInstance['status'] } : {}),
          ...(currentStageIds ? { current_stage_ids: currentStageIds } : {}),
        });
        broadcast('instance:updated', { instanceId }, { instanceId });
        return { ok: true };
      } catch (err) {
        console.error('[workflow-context-sync] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/internal/workflow-finished
  typedApp.post(
    '/api/internal/workflow-finished',
    {
      schema: { body: WorkflowFinishedBody },
    },
    async (request, reply) => {
      try {
        const { instanceId, status, context, error: errorMsg } = request.body;
        console.log(`[workflow-finished] Instance ${instanceId} -> ${status}${errorMsg ? ` error: ${errorMsg}` : ''}`);

        // Guard: instance may have been deleted by a concurrent workflow deletion.
        const existing = deps.db.getInstance(instanceId);
        if (!existing) {
          return reply.status(200).send({ ignored: true, reason: 'instance_deleted' });
        }

        deps.db.updateInstance(instanceId, {
          status: status as WorkflowInstance['status'],
          context: context as WorkflowInstance['context'],
          ...(status === 'completed' || status === 'failed' ? { completed_at: new Date().toISOString() } : {}),
        });
        broadcast('instance:updated', { instanceId, status }, { instanceId });
        return { ok: true };
      } catch (err) {
        console.error('[workflow-finished] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/internal/workflow-context/:instanceId/:stageId
  typedApp.get(
    '/api/internal/workflow-context/:instanceId/:stageId',
    {
      schema: { params: z.object({ instanceId: z.string(), stageId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { instanceId } = request.params;
        const status = await restateClient.getWorkflowStatus(instanceId);
        return status.context;
      } catch (err) {
        console.error('[workflow-context] Error:', err);
        return { trigger: {}, stages: {} };
      }
    },
  );

  // POST /api/internal/spawn-agent
  typedApp.post(
    '/api/internal/spawn-agent',
    {
      schema: { body: SpawnAgentBody },
    },
    async (request, reply) => {
      try {
        const {
          instanceId,
          stageId,
          iteration = 1,
          agentId,
          prompt,
          overrides,
          definitionId,
          acpProvider,
          timeout_minutes,
        } = request.body;

        // Guard: if the instance was deleted (workflow deletion raced with Restate
        // scheduling this spawn), bail out cleanly instead of starting an orphan.
        const instanceExists = deps.db.getInstance(instanceId);
        if (!instanceExists) {
          console.warn(`[spawn-agent] Instance ${instanceId} not found — skipping spawn (likely deleted)`);
          return reply.status(200).send({ ignored: true, reason: 'instance_deleted' });
        }

        console.log(
          `[spawn-agent] Spawning ${agentId} for ${instanceId}:${stageId} (iter ${iteration})${acpProvider ? ` [provider: ${acpProvider}]` : ''}${timeout_minutes != null ? ` [timeout: ${timeout_minutes}m]` : ''}`,
        );

        // Persist the rendered prompt so it's visible in the Prompt tab
        db.storeRenderedPrompt(instanceId, stageId, iteration, prompt);

        // Resolve effective provider using priority order:
        // 1. Stage/workflow override from request body (acpProvider field)
        // 2. System default from DB settings
        // 3. Env var fallback (acpPool uses config.acpProvider on construction)
        // 4. Pool's own default (kiro)
        const resolvedProviderName =
          acpProvider ||
          deps.db.getSetting('acpProvider') ||
          appConfig.acpProvider ||
          undefined;
        const providerOverride = resolvedProviderName ? await createProviderAsync(resolvedProviderName) : undefined;

        const { client } = await state.acpPool.spawn({
          instanceId,
          stageId,
          config: {
            agentId,
            overrides,
          },
          orchestratorPort: appConfig.port,
          definitionId,
          ...(providerOverride ? { providerOverride } : {}),
        });

        // Wire ACP events using shared helper + turn-end nudge
        const stageKey = `${instanceId}:${stageId}`;
        let nudgeCount = 0;

        wireAcpEvents(client, db, {
          instanceId,
          stageId,
          iteration,
          eventPrefix: 'agent',
          filterPayload: { instanceId, stageId },
          scope: { instanceId },
          onTurnEnd: () => {
            // If the agent already signalled (completed/failed), or was force-stopped, skip
            if (state.signalledStages.has(stageKey)) return;
            if (state.forceStoppedStages.has(stageKey)) {
              state.forceStoppedStages.delete(stageKey); // clean up after consuming
              return;
            }
            // Only nudge once to avoid infinite loops
            if (nudgeCount > 0) return;
            nudgeCount++;

            const nudgeClient = state.acpPool.getClient(instanceId, stageId);
            if (!nudgeClient) return;

            console.log(`[nudge] Agent ${stageId} ended turn without calling workflow_signal — nudging`);
            nudgeClient
              .prompt(
                'Your turn ended but you have not called `workflow_signal` yet. You MUST indicate your status before stopping:\n' +
                  '- Call workflow_signal with status "completed" and your output if you finished successfully\n' +
                  '- Call workflow_signal with status "failed" and an error reason if you cannot continue\n' +
                  '- Call workflow_signal with status "waiting_input" and a prompt if you need human help\n' +
                  'Please call workflow_signal now.',
              )
              .catch((err) => {
                console.error(`[nudge] Failed for ${stageKey}:`, err);
              });
          },
        });

        // Store session for future resume (e.g. user sends follow-up after completion)
        const sessionKey = stageKey;
        const sid = state.acpPool.getSessionId(instanceId, stageId);
        if (sid) db.upsertAcpSession(sessionKey, sid, client.pid);

        // Schedule agent timeout if configured
        if (timeout_minutes != null) {
          // Clear any pre-existing timer (e.g. prior iteration of a cycled stage)
          clearStageTimeout(state.stageTimeouts, stageKey);

          const timeoutMs = timeout_minutes * 60 * 1000;
          console.log(`[agent-timeout] Scheduling failure for ${stageKey} in ${timeout_minutes}m`);

          const handle = setTimeout(async () => {
            state.stageTimeouts.delete(stageKey);

            // Don't double-signal if the stage already completed
            if (state.signalledStages.has(stageKey)) return;

            console.log(`[agent-timeout] Timeout fired for ${stageKey} — killing agent and failing stage`);

            // Mark as signalled to suppress the nudge
            state.signalledStages.add(stageKey);

            // Kill the ACP process
            await state.acpPool.terminate(instanceId, stageId).catch(() => {});

            // Signal the Restate workflow that the stage failed
            await restateClient
              .signalStageFailed(instanceId, stageId, `Agent stage timed out after ${timeout_minutes} minute(s)`)
              .catch((err: unknown) => {
                console.error(`[agent-timeout] Failed to signal stage failure for ${stageKey}:`, errorMessage(err));
              });

            broadcast(
              'instance:stage_failed',
              {
                instanceId,
                stageId,
                error: `Agent stage timed out after ${timeout_minutes} minute(s)`,
              },
              { instanceId },
            );
          }, timeoutMs);

          state.stageTimeouts.set(stageKey, handle);
        }

        // Send the initial prompt to the agent
        await client.prompt(prompt);

        return { ok: true, sessionId: client.currentSessionId };
      } catch (err) {
        console.error('[spawn-agent] Failed:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/internal/kill-agent
  typedApp.post(
    '/api/internal/kill-agent',
    {
      schema: { body: KillAgentBody },
    },
    async (request, reply) => {
      try {
        const { instanceId, stageId } = request.body;
        const stageKey = `${instanceId}:${stageId}`;
        // Cancel any pending timeout for this stage
        clearStageTimeout(state.stageTimeouts, stageKey);
        // Terminate regardless of whether the instance still exists — if the pool
        // has an entry for this key we want to clean it up either way.
        await state.acpPool.terminate(instanceId, stageId);
        // Clean up tracking state
        state.signalledStages.delete(stageKey);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/internal/author-draft/:workflowId — Get current draft or saved workflow
  typedApp.get(
    '/api/internal/author-draft/:workflowId',
    {
      schema: { params: z.object({ workflowId: z.string() }) },
    },
    async (request, reply) => {
      const { workflowId } = request.params;
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
      const { workflowId } = request.params;
      const draft = request.body;
      saveDraft(db, state.authorDrafts, workflowId, draft as unknown as WorkflowDefinition);
      return { ok: true };
    },
  );

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
        if (sourceStage && !nodeRegistry.isTriggerType(sourceStage.type)) {
          parts.push(`    template vars: {{ output.<field> }} = ${e.source}'s output`);
        } else if (sourceStage && nodeRegistry.isTriggerType(sourceStage.type)) {
          parts.push(`    template vars: {{ trigger.<field> }} = trigger payload`);
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

    // Include OpenAPI spec on first message of the session
    if (!state.authorSpecSent.has(workflowId)) {
      const fullSpec = app.swagger();
      const draftSpec = {
        ...fullSpec,
        paths: Object.fromEntries(Object.entries(fullSpec.paths || {}).filter(([p]) => p.startsWith('/api/draft/'))),
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

  function authorSessionConfig(workflowId: string): SessionConfig {
    const orchestratorPort = appConfig.port;
    return {
      pool: state.authorPool,
      instanceId: 'author',
      stageId: workflowId,
      iteration: 1,
      agentId: 'workflow-author',
      overrides: {
        additional_mcp_servers: [
          {
            name: 'workflow_author',
            command: 'node',
            args: [join(process.cwd(), 'dist', 'mcp', 'workflow-author-server.js')],
            env: {
              WORKFLOW_ID: workflowId,
              ORCHESTRATOR_PORT: String(orchestratorPort),
            },
          },
        ],
      },
      eventPrefix: 'author',
      filterPayload: { workflowId },
      scope: { workflowId },
      cullKey: `author:${workflowId}`,
    };
  }

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

  // POST /api/internal/validate-code — TypeScript type-checking for the code editor
  typedApp.post(
    '/api/internal/validate-code',
    { schema: { body: ValidateCodeBody } },
    async (request) => {
      try {
        const { code, outputSchema, nodeType } = request.body;
        const diagnostics = validateCode({ code, outputSchema, nodeType });
        return { diagnostics };
      } catch (err) {
        console.error('[validate-code] Error:', err);
        return { diagnostics: [] };
      }
    },
  );
}
