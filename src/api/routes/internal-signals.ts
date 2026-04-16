import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { broadcast } from '../websocket.js';
import type { RouteDeps, SharedState } from './shared.js';
import { wireAcpEvents } from './agent-utils.js';
import { errorMessage } from '../../utils/errors.js';
import { config as appConfig } from '../../config.js';
import { createProvider } from '../../acp/provider/registry.js';
import { notifyWorkflowFinished } from '../../workflow/test-run-listener.js';

// Zod schemas

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

export function registerSignalRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
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
            // Resolve the runner's wait for this stage
            state.runner.resolveWait(instanceId, `stage-complete-${stageId}`, output);
            broadcast('instance:stage_completed', { instanceId, stageId, output }, { instanceId });
            state.signalledStages.add(key);
            // Also notify workflow-finished listeners for terminal signal
            try {
              // Check if this was the final stage completing the workflow
              const instance = db.getInstance(instanceId);
              if (instance?.status === 'completed') {
                notifyWorkflowFinished(instanceId, 'completed');
              }
            } catch { /* non-fatal */ }
            return { ok: true, message: 'Stage completed successfully. Output has been recorded.' };

          case 'failed':
            // Cancel any pending timeout — stage already failed
            clearStageTimeout(state.stageTimeouts, key);
            // Reject the runner's wait for this stage
            state.runner.rejectWait(instanceId, `stage-complete-${stageId}`, errorMsg || 'Agent signalled failure');
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

        // Persist status change so the approvals query (and other DB-backed queries) reflect it
        if (status === 'waiting_gate' || status === 'waiting_input') {
          db.updateInstance(instanceId, { status });
        }

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
                state.runner.resolveWait(instanceId, `gate-${stageId}`, undefined);
                db.updateInstance(instanceId, { status: 'running' });
                broadcast('instance:gate_approved', { instanceId, stageId, reason: 'timeout' }, { instanceId });
              } else {
                state.runner.rejectWait(instanceId, `gate-${stageId}`, `Gate timed out after ${timeout_minutes} minute(s)`);
                db.updateInstance(instanceId, { status: 'running' });
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

  // GET /api/internal/workflow-context/:instanceId/:stageId
  // Direct DB read — no longer proxies to Restate.
  typedApp.get(
    '/api/internal/workflow-context/:instanceId/:stageId',
    {
      schema: { params: z.object({ instanceId: z.string(), stageId: z.string() }) },
    },
    async (request, reply) => {
      try {
        const { instanceId, stageId } = request.params;
        const instance = db.getInstance(instanceId);
        if (!instance) {
          return reply.code(404).send({ error: `Instance "${instanceId}" not found` });
        }
        const context = instance.context;
        if (!context || !(stageId in context.stages)) {
          return reply.code(404).send({ error: `Stage "${stageId}" not found in workflow context` });
        }
        return { trigger: context.trigger, stages: context.stages };
      } catch (err) {
        console.error('[workflow-context] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
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

        // Guard: if the instance was deleted, bail out cleanly
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
        const providerOverride = resolvedProviderName ? createProvider(resolvedProviderName) : undefined;

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

        // Persist ACP session to DB *before* sending the initial prompt.
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

            // Reject the runner's wait for this stage
            state.runner.rejectWait(
              instanceId,
              `stage-complete-${stageId}`,
              `Agent stage timed out after ${timeout_minutes} minute(s)`,
            );

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
        // Terminate regardless of whether the instance still exists
        await state.acpPool.terminate(instanceId, stageId);
        // Clean up tracking state
        state.signalledStages.delete(stageKey);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
