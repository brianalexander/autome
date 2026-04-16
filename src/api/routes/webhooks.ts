import { timingSafeEqual } from 'crypto';
import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { safeEvalCondition } from '../../engine/safe-eval.js';
import { nodeRegistry } from '../../nodes/registry.js';
import type { RouteDeps, SharedState } from './shared.js';
import { errorMessage } from '../../utils/errors.js';
import { launchWorkflow } from '../../workflow/launch.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const WebhookParams = z.object({ workflowId: z.string() });

export function registerWebhookRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/webhooks/:workflowId — Webhook trigger endpoint for external services
  typedApp.post(
    '/api/webhooks/:workflowId',
    {
      schema: { params: WebhookParams },
    },
    async (request, reply) => {
      try {
        const { workflowId } = request.params;
        const workflow = deps.db.getWorkflow(workflowId);
        if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

        // Find webhook trigger stage(s) in the workflow
        const webhookTrigger = workflow.stages.find((s) => s.type === 'webhook-trigger');
        if (!webhookTrigger) {
          return reply.code(400).send({ error: 'Workflow has no webhook trigger. Add a "webhook-trigger" stage.' });
        }

        // Validate secret if configured
        const triggerConfig = (webhookTrigger.config || {}) as Record<string, unknown> & {
          webhook?: { secret?: string; payload_filter?: string };
          payload_schema?: Record<string, unknown>;
        };
        const secret = triggerConfig.webhook?.secret;
        if (secret) {
          const provided = request.headers['x-webhook-secret'] as string;
          if (!provided || !safeCompare(provided, secret)) {
            return reply.code(401).send({ error: 'Invalid webhook secret' });
          }
        }

        // Optional payload filter
        const payloadFilter = triggerConfig.webhook?.payload_filter;
        if (payloadFilter) {
          try {
            if (!safeEvalCondition(payloadFilter, { payload: request.body })) {
              return reply.code(200).send({ filtered: true, message: 'Payload did not match filter' });
            }
          } catch (err) {
            console.error('[webhook] Payload filter error:', err);
          }
        }

        // Create the trigger event
        const { v4: uuid } = await import('uuid');
        const event = {
          id: uuid(),
          provider: 'webhook',
          type: 'trigger',
          timestamp: new Date().toISOString(),
          payload: request.body,
          metadata: {
            source_ip: request.ip,
            headers: {
              'content-type': request.headers['content-type'],
              'user-agent': request.headers['user-agent'],
            },
          },
        };

        // Create instance and start workflow via runner
        const nonTriggerStageIds = workflow.stages
          .filter((s) => !nodeRegistry.isTriggerType(s.type))
          .map((s) => s.id);

        const { instance, runnerError, validationError } = await launchWorkflow(
          deps.db,
          state.runner,
          workflow,
          event,
          nonTriggerStageIds,
          workflow.id,
          { markEntryStagesOnError: false, initiatedBy: 'webhook' },
        );
        if (validationError) {
          return reply.code(422).send({ error: 'Payload validation failed', details: validationError });
        }
        if (runnerError) {
          console.error('[webhook] Runner error:', runnerError);
        }

        // Return run info to the caller (instance is defined — we returned early on validationError)
        const baseUrl = `${request.protocol}://${request.hostname}`;
        return reply.code(201).send({
          instance_id: instance!.id,
          status: 'running',
          url: `${baseUrl}/instances/${instance!.id}`,
          workflow_name: workflow.name,
          triggered_at: event.timestamp,
        });
      } catch (err) {
        console.error('[webhook] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
