import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { InitiatedBy } from '../../types/instance.js';
import { broadcast } from '../websocket.js';
import type { RouteDeps, SharedState } from './shared.js';
import type { SessionConfig } from './agent-utils.js';
import { sendChatMessage } from './agent-utils.js';
import { errorMessage } from '../../utils/errors.js';
import { launchWorkflowWithResume } from '../../workflow/launch.js';
import { nodeRegistry } from '../../nodes/registry.js';

// Zod schemas for instance routes
const InstanceIdParams = z.object({ id: z.string() });
const InstanceStageParams = z.object({ id: z.string(), stageId: z.string() });
const InstanceQuerySchema = z.object({
  status: z.string().optional(),
  definitionId: z.string().optional(),
  initiatedBy: z.enum(['user', 'author', 'webhook', 'cron']).optional(),
  limit: z.coerce.number().min(1).max(200).default(50).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
});
const SegmentsQuerySchema = z.object({
  iteration: z.string().optional(),
});
const PromptQuerySchema = z.object({
  iteration: z.string().optional(),
});
const GateApproveBody = z.object({ data: z.unknown().optional() });
const GateRejectBody = z.object({
  reason: z.string().optional(),
});
const ResumeBody = z.object({
  fromStageId: z.string().optional(),
});
const StageMessageBody = z.object({
  message: z.string(),
});

export function registerInstanceRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  typedApp.get(
    '/api/instances',
    {
      schema: { querystring: InstanceQuerySchema },
    },
    async (request, reply) => {
      try {
        const query = request.query;
        const filter: { status?: string; definitionId?: string; initiatedBy?: InitiatedBy; limit?: number; offset?: number } = {};
        if (query.status) filter.status = query.status;
        if (query.definitionId) filter.definitionId = query.definitionId;
        if (query.initiatedBy) filter.initiatedBy = query.initiatedBy as InitiatedBy;
        if (query.limit != null) filter.limit = query.limit;
        if (query.offset != null) filter.offset = query.offset;
        const result = db.listInstances(filter);
        return { data: result.data, total: result.total, limit: query.limit ?? 50, offset: query.offset ?? 0 };
      } catch (err) {
        console.error('GET /api/instances error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/approvals — list all pending gate approvals across all instances
  typedApp.get('/api/approvals', async (request, reply) => {
    try {
      const { data: gateInstances } = db.listInstances({ status: 'waiting_gate', limit: 200 });
      const { data: inputInstances } = db.listInstances({ status: 'waiting_input', limit: 200 });
      const waitingInstances = [...gateInstances, ...inputInstances];

      const approvals: Array<{
        instanceId: string;
        workflowName: string;
        workflowId: string;
        stageId: string;
        stageLabel: string;
        gateMessage: string | null;
        upstreamData: unknown;
        waitingSince: string;
      }> = [];

      for (const inst of waitingInstances) {
        const def = inst.definition_id ? db.getWorkflow(inst.definition_id) : null;
        const context = inst.context;
        if (!context?.stages) continue;

        for (const [stageId, stageCtx] of Object.entries(context.stages)) {
          if (stageCtx.status !== 'running') continue;

          // Find the stage definition and confirm it's a manual gate
          const stageDef = def?.stages?.find((s: { id: string }) => s.id === stageId);
          if (!stageDef || stageDef.type !== 'gate') continue;
          const gateConfig = (stageDef.config || {}) as Record<string, unknown>;
          if (gateConfig.type !== 'manual') continue;

          // Collect upstream output for display
          const upstreamEdges = (def?.edges || []).filter((e: { target: string }) => e.target === stageId);
          let upstreamData: unknown;
          if (upstreamEdges.length === 1) {
            upstreamData = context.stages[(upstreamEdges[0] as { source: string }).source]?.latest;
          } else if (upstreamEdges.length > 1) {
            const merged: Record<string, unknown> = {};
            for (const edge of upstreamEdges as Array<{ source: string }>) {
              merged[edge.source] = context.stages[edge.source]?.latest;
            }
            upstreamData = merged;
          }

          approvals.push({
            instanceId: inst.id,
            workflowName: def?.name ?? 'Unknown Workflow',
            workflowId: inst.definition_id ?? '',
            stageId,
            stageLabel: (stageDef.label as string | undefined) ?? stageId,
            gateMessage: (gateConfig.message as string) || null,
            upstreamData,
            waitingSince: inst.updated_at ?? inst.created_at,
          });
        }
      }

      return approvals;
    } catch (err) {
      console.error('[approvals] Error:', err);
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  typedApp.get(
    '/api/instances/:id',
    {
      schema: { params: InstanceIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const instance = db.getInstance(id);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });
        return instance;
      } catch (err) {
        console.error('GET /api/instances/:id error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/instances/:id/definition — Get the workflow definition for this instance's version
  typedApp.get(
    '/api/instances/:id/definition',
    {
      schema: { params: InstanceIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const def = db.getInstanceDefinition(id);
        if (!def) return reply.code(404).send({ error: 'Definition not found for instance' });
        return def;
      } catch (err) {
        console.error('GET /api/instances/:id/definition error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/instances/:id
  typedApp.delete(
    '/api/instances/:id',
    {
      schema: { params: InstanceIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const instance = deps.db.getInstance(id);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });
        deps.db.deleteInstance(id);
        return reply.code(204).send();
      } catch (err) {
        console.error('DELETE /api/instances/:id error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/cancel — Stop a running workflow instance
  typedApp.post(
    '/api/instances/:id/cancel',
    {
      schema: { params: InstanceIdParams },
    },
    async (request, reply) => {
      try {
        const { id: instanceId } = request.params;
        const instance = deps.db.getInstance(instanceId);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });

        // Use DB context (the runner writes state directly to DB so it's always authoritative)
        const liveContext = instance.context;

        // Find all running stages from live context
        const runningStages = Object.entries(liveContext?.stages || {})
          .filter(([, ctx]) => ctx.status === 'running')
          .map(([stageId]) => stageId);

        console.log(
          `[stop] Instance ${instanceId}: stopping ${runningStages.length} running stages: ${runningStages.join(', ')}`,
        );

        // 2. Kill all running agent processes
        for (const stageId of runningStages) {
          const client = state.acpPool.getClient(instanceId, stageId);
          if (client) {
            client.cancel();
            setTimeout(async () => {
              const stillActive = state.acpPool.getClient(instanceId, stageId);
              if (stillActive) {
                await state.acpPool.terminate(instanceId, stageId);
              }
            }, 2000);
          }
        }

        // Also force-terminate any ACP processes for stages we might have missed
        for (const stageId of Object.keys(liveContext?.stages || {})) {
          if (!runningStages.includes(stageId)) {
            const client = state.acpPool.getClient(instanceId, stageId);
            if (client) {
              await state.acpPool.terminate(instanceId, stageId);
            }
          }
        }

        // 3. Cancel the workflow runner (aborts the in-memory execution)
        await state.runner.cancel(instanceId).catch((err) => {
          console.warn('[stop] Could not cancel runner workflow:', err);
        });

        // 4. Update DB — merge live context and mark running stages as stopped
        const updatedContext = JSON.parse(JSON.stringify(liveContext));
        for (const stageId of runningStages) {
          if (updatedContext.stages?.[stageId]) {
            updatedContext.stages[stageId].status = 'failed';
            const lastRun = updatedContext.stages[stageId].runs?.[updatedContext.stages[stageId].runs.length - 1];
            if (lastRun && lastRun.status === 'running') {
              lastRun.status = 'failed';
              lastRun.completed_at = new Date().toISOString();
              lastRun.error = 'Workflow stopped by user';
            }
          }
        }

        // Clear any pending timeouts (agent timeouts, gate timeouts) for this instance
        for (const [key, handle] of state.stageTimeouts.entries()) {
          if (key.startsWith(`${instanceId}:`)) {
            clearTimeout(handle);
            state.stageTimeouts.delete(key);
          }
        }

        deps.db.updateInstance(instanceId, {
          status: 'cancelled',
          context: updatedContext,
          completed_at: new Date().toISOString(),
        });
        broadcast('instance:cancelled', { instanceId }, { instanceId });

        return { cancelled: true, stoppedStages: runningStages };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/resume — Resume a failed or cancelled workflow instance
  typedApp.post(
    '/api/instances/:id/resume',
    {
      schema: { params: InstanceIdParams, body: ResumeBody },
    },
    async (request, reply) => {
      try {
        const { id: instanceId } = request.params;
        const { fromStageId } = request.body;

        // 1. Get the instance from DB
        const instance = deps.db.getInstance(instanceId);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });

        // 2. Guard: only failed or cancelled instances can be resumed
        if (instance.status !== 'failed' && instance.status !== 'cancelled') {
          return reply.code(409).send({
            error: `Cannot resume instance with status '${instance.status}'. Only failed or cancelled instances can be resumed.`,
          });
        }

        // 3. Get the version-pinned workflow definition stored with this instance
        const definition = deps.db.getInstanceDefinition(instanceId);
        if (!definition) return reply.code(404).send({ error: 'Workflow definition not found' });

        // 4. Guard: definition version must match
        if (instance.definition_version != null && definition.version != null && definition.version !== instance.definition_version) {
          return reply.code(409).send({
            error: `Definition has been modified since this run (version ${instance.definition_version} → ${definition.version}). Re-run from trigger instead.`,
          });
        }

        // 5. Determine fromStageIds
        let fromStageIds: string[];
        if (fromStageId) {
          fromStageIds = [fromStageId];
        } else {
          const stages = instance.context?.stages ?? {};
          // Primary: any failed stage (the classic failed-run resume case)
          fromStageIds = Object.entries(stages)
            .filter(([, ctx]) => ctx.status === 'failed')
            .map(([id]) => id);

          // Fallback: for cancelled instances with no failed stages (the user
          // clicked Stop BETWEEN stages), resume from any still-running stage
          // plus any pending stage whose upstream dependencies are all complete.
          if (fromStageIds.length === 0 && instance.status === 'cancelled') {
            const runningStageIds = Object.entries(stages)
              .filter(([, ctx]) => ctx.status === 'running')
              .map(([id]) => id);

            const nextUpStageIds = Object.entries(stages)
              .filter(([id, ctx]) => {
                if (ctx.status !== 'pending') return false;
                // Find upstream on_success edges in the definition
                const upstream = definition.edges
                  .filter((e) => e.target === id && (e.trigger || 'on_success') === 'on_success')
                  .map((e) => e.source);
                if (upstream.length === 0) return false; // trigger stages excluded
                return upstream.every((srcId) => {
                  const srcStatus = stages[srcId]?.status;
                  return srcStatus === 'completed' || srcStatus === 'skipped';
                });
              })
              .map(([id]) => id);

            fromStageIds = Array.from(new Set([...runningStageIds, ...nextUpStageIds]));
          }

          if (fromStageIds.length === 0) {
            return reply.code(400).send({
              error:
                instance.status === 'cancelled'
                  ? 'No resumable stages found. The run may already be complete.'
                  : 'No failed stages found to resume from.',
            });
          }
        }

        // 6. Validate that all fromStageIds exist in the definition
        const definedStageIds = new Set(definition.stages.map((s) => s.id));
        for (const sid of fromStageIds) {
          if (!definedStageIds.has(sid)) {
            return reply.code(400).send({ error: `Stage '${sid}' not found in workflow definition.` });
          }
        }

        // 6b. Guard: none of the fromStageIds may be trigger stages
        const triggerStageIds = definition.stages
          .filter(s => nodeRegistry.isTriggerType(s.type))
          .map(s => s.id);
        const triggerConflicts = fromStageIds.filter(id => triggerStageIds.includes(id));
        if (triggerConflicts.length > 0) {
          return reply.code(400).send({
            error: `Cannot resume from trigger stage(s): ${triggerConflicts.join(', ')}. Resume from a non-trigger stage instead.`,
          });
        }

        // 7. Atomic compare-and-swap: flip status from failed/cancelled → running
        const locked = deps.db.atomicResumeInstance(instanceId);
        if (!locked) {
          return reply.code(409).send({ error: 'Instance is already being resumed by another request.' });
        }

        // 8. Launch the resume
        const result = await launchWorkflowWithResume(deps.db, state.runner, instance, definition, fromStageIds);

        // 9. If runnerError, roll back to the original status and return 500
        if (result.runnerError) {
          deps.db.updateInstance(instanceId, { status: instance.status });
          return reply.code(500).send({ error: `Failed to start resumed workflow: ${result.runnerError}` });
        }

        // 10. Return success
        return {
          instanceId,
          resumeCount: result.resumeCount,
          fromStageIds,
        };
      } catch (err) {
        console.error('[resume] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/instances/:id/status — Get real-time status from DB
  // The runner writes status and context directly to DB so it's always authoritative.
  typedApp.get(
    '/api/instances/:id/status',
    {
      schema: { params: InstanceIdParams },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const instance = deps.db.getInstance(id);
        if (!instance) return reply.code(404).send({ error: 'Instance not found' });
        return {
          status: instance.status,
          context: instance.context,
          currentStageIds: instance.current_stage_ids,
        };
      } catch (err) {
        console.error('GET /api/instances/:id/status error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/instances/:id/gates/:stageId/approve
  typedApp.post(
    '/api/instances/:id/gates/:stageId/approve',
    {
      schema: { params: InstanceStageParams, body: GateApproveBody },
    },
    async (request, reply) => {
      try {
        const { id, stageId } = request.params;
        const { data } = request.body;
        // Cancel any scheduled timeout for this gate — human approved before it fired
        const gateKey = `${id}:${stageId}`;
        const existingTimeout = state.stageTimeouts.get(gateKey);
        if (existingTimeout !== undefined) {
          clearTimeout(existingTimeout);
          state.stageTimeouts.delete(gateKey);
        }
        // resolveWait updates the DB gate row and fires the in-memory resolver.
        // The gate executor expects `{approved: boolean, data?: unknown}`.
        state.runner.resolveWait(id, `gate-${stageId}`, { approved: true, data });
        db.updateInstance(id, { status: 'running' });
        broadcast(
          'instance:gate_approved',
          {
            instanceId: id,
            stageId,
          },
          { instanceId: id },
        );
        return { approved: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/gates/:stageId/reject
  typedApp.post(
    '/api/instances/:id/gates/:stageId/reject',
    {
      schema: { params: InstanceStageParams, body: GateRejectBody },
    },
    async (request, reply) => {
      try {
        const { id, stageId } = request.params;
        const body = request.body;
        // Cancel any scheduled timeout for this gate — human rejected before it fired
        const gateKey = `${id}:${stageId}`;
        const existingTimeout = state.stageTimeouts.get(gateKey);
        if (existingTimeout !== undefined) {
          clearTimeout(existingTimeout);
          state.stageTimeouts.delete(gateKey);
        }
        // Resolve with {approved: false} so the gate executor's own TerminalError
        // logic can produce a clean "Gate was rejected" failure, rather than a
        // raw runner rejection that surfaces as an unrelated promise error.
        state.runner.resolveWait(id, `gate-${stageId}`, { approved: false, data: body.reason });
        // The gate executor will throw TerminalError → runner marks instance failed.
        broadcast(
          'instance:gate_rejected',
          {
            instanceId: id,
            stageId,
            reason: body.reason,
          },
          { instanceId: id },
        );
        return { rejected: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/stages/:stageId/message — Send message to agent (auto-spawns if needed)
  typedApp.post(
    '/api/instances/:id/stages/:stageId/message',
    {
      schema: { params: InstanceStageParams, body: StageMessageBody },
    },
    async (request, reply) => {
      try {
        const { id: instanceId, stageId } = request.params;
        const { message } = request.body;

        // Look up agent config from workflow definition
        const instance = db.getInstance(instanceId);
        if (!instance) return reply.code(404).send({ error: `Instance not found: ${instanceId}` });
        const workflow = instance.definition_id ? db.getWorkflow(instance.definition_id) : null;
        if (!workflow) return reply.code(404).send({ error: `Workflow not found` });
        const stageDef = workflow.stages.find((s) => s.id === stageId);
        const stageConfig = stageDef?.config as Record<string, unknown> | undefined;
        if (!stageConfig?.agentId)
          return reply.code(400).send({ error: `${stageId} is not an agent stage` });

        const stageCtx = instance.context?.stages?.[stageId];
        const iteration = stageCtx?.run_count || 1;

        await sendChatMessage(
          {
            config: {
              pool: state.acpPool,
              instanceId,
              stageId,
              iteration,
              agentId: (stageConfig.agentId as string) || '',
              overrides: stageConfig.overrides as SessionConfig['overrides'] ?? undefined,
              eventPrefix: 'agent',
              filterPayload: { instanceId, stageId },
              scope: { instanceId },
            },
            message,
          },
          db,
        );

        return { injected: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/instances/:id/stages/:stageId/segments
  typedApp.get(
    '/api/instances/:id/stages/:stageId/segments',
    {
      schema: { params: InstanceStageParams, querystring: SegmentsQuerySchema },
    },
    async (request, reply) => {
      try {
        const { id, stageId } = request.params;
        const query = request.query;
        const iteration = query.iteration ? parseInt(query.iteration, 10) : undefined;
        const segments = deps.db.getSegments(id, stageId, iteration);
        return segments;
      } catch (err) {
        console.error('[segments] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/instances/:id/stages/:stageId/prompt — Get the rendered prompt sent to a stage
  typedApp.get(
    '/api/instances/:id/stages/:stageId/prompt',
    {
      schema: { params: InstanceStageParams, querystring: PromptQuerySchema },
    },
    async (request, reply) => {
      try {
        const { id, stageId } = request.params;
        const query = request.query;
        const iteration = query.iteration ? parseInt(query.iteration, 10) : undefined;
        const promptRecord = db.getRenderedPrompt(id, stageId, iteration);
        if (!promptRecord) return reply.code(404).send({ error: 'No rendered prompt found' });
        return { prompt: promptRecord.prompt, iteration: promptRecord.iteration, created_at: promptRecord.created_at };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/stages/:stageId/cancel — Force-stop a running stage agent
  typedApp.post(
    '/api/instances/:id/stages/:stageId/cancel',
    {
      schema: { params: InstanceStageParams },
    },
    async (request, reply) => {
      try {
        const { id: instanceId, stageId } = request.params;
        const key = `${instanceId}:${stageId}`;
        state.forceStoppedStages.add(key);
        setTimeout(() => state.forceStoppedStages.delete(key), 5 * 60 * 1000);

        // Sweep all pending/in_progress tool calls to failed
        const instance = deps.db.getInstance(instanceId);
        const iteration = instance?.context?.stages?.[stageId]?.run_count || 1;
        deps.db.sweepToolCallStatuses(instanceId, stageId, iteration, ['pending', 'in_progress'], 'failed');

        // Send session/cancel first (graceful stop)
        const client = state.acpPool.getClient(instanceId, stageId);
        if (client) {
          client.cancel();
          // Safety timeout: force-kill if agent doesn't stop within 2s
          setTimeout(async () => {
            const stillActive = state.acpPool.getClient(instanceId, stageId);
            if (stillActive) {
              await state.acpPool.terminate(instanceId, stageId);
            }
          }, 2000);
        }

        broadcast('agent:cancelled', { instanceId, stageId }, { instanceId });
        return { cancelled: true };
      } catch (err) {
        console.error('[cancel-stage] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/instances/:id/stages/:stageId/restart-session — Destroy agent session
  typedApp.post(
    '/api/instances/:id/stages/:stageId/restart-session',
    {
      schema: { params: InstanceStageParams },
    },
    async (request, reply) => {
      try {
        const { id: instanceId, stageId } = request.params;
        await state.acpPool.terminate(instanceId, stageId);
        const sessionKey = `${instanceId}:${stageId}`;
        db.markAcpSessionStatus(sessionKey, 'destroyed');
        state.signalledStages.delete(sessionKey);
        broadcast('agent:session_status', { instanceId, stageId, status: 'pending_restart' }, { instanceId });
        return { ok: true };
      } catch (err) {
        console.error('[agent/restart-session] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
