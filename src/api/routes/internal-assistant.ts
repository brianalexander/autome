import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { broadcast } from '../websocket.js';
import type { RouteDeps, SharedState } from './shared.js';
import { sendChatMessage } from './agent-utils.js';
import { buildAssistantSessionConfig } from './assistant-session-config.js';
import { errorMessage } from '../../utils/errors.js';

// Zod schemas

const AssistantChatBody = z.object({
  message: z.string(),
  contextHints: z
    .object({
      instanceId: z.string().optional(),
    })
    .optional(),
});

const AssistantStopBody = z.object({});

export function registerAssistantRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  const assistantSessionConfig = () => buildAssistantSessionConfig(state.assistantPool);

  // POST /api/assistant/chat — Send a message to the assistant AI
  typedApp.post(
    '/api/assistant/chat',
    {
      schema: { body: AssistantChatBody },
    },
    async (request, reply) => {
      try {
        const { message, contextHints } = request.body;

        await sendChatMessage(
          {
            config: assistantSessionConfig(),
            message,
            // Context hints (e.g. currently-viewed instance) are passed through
            // as a system context message for future enhancement — for now we
            // include them as a preamble if provided.
            buildContext: contextHints?.instanceId
              ? async () => `<context>\nCurrently viewing instance: ${contextHints.instanceId}\n</context>`
              : undefined,
          },
          db,
        );

        return { ok: true };
      } catch (err) {
        console.error('[assistant/chat] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/assistant/stop — Cancel the current assistant turn (session stays alive)
  typedApp.post(
    '/api/assistant/stop',
    {
      schema: { body: AssistantStopBody },
    },
    async (request, reply) => {
      try {
        const client = state.assistantPool.getClient('assistant', 'global');
        if (client) {
          client.cancel();
        }

        broadcast('assistant:cancelled', {}, undefined);
        return { stopped: true };
      } catch (err) {
        console.error('[assistant/stop] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // GET /api/assistant/segments — Load persisted assistant chat segments
  typedApp.get(
    '/api/assistant/segments',
    async (request, reply) => {
      try {
        return db.getSegments('assistant', 'global', 1);
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // DELETE /api/assistant/segments — Clear assistant chat history
  typedApp.delete(
    '/api/assistant/segments',
    async (request, reply) => {
      try {
        db.deleteSegments('assistant', 'global', 1);
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/assistant/restart-session — Destroy session, next message spawns fresh
  typedApp.post(
    '/api/assistant/restart-session',
    async (request, reply) => {
      try {
        await state.assistantPool.terminate('assistant', 'global');
        db.markAcpSessionStatus('assistant:global', 'destroyed');
        broadcast('assistant:session_status', { status: 'pending_restart' }, undefined);
        return { ok: true };
      } catch (err) {
        console.error('[assistant/restart-session] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // POST /api/assistant/clear-chat — Kill session + wipe history for a fresh start
  typedApp.post(
    '/api/assistant/clear-chat',
    async (request, reply) => {
      try {
        await state.assistantPool.terminate('assistant', 'global');
        db.markAcpSessionStatus('assistant:global', 'destroyed');
        db.deleteSegments('assistant', 'global', 1);
        broadcast('assistant:session_status', { status: 'cleared' }, undefined);
        return { ok: true };
      } catch (err) {
        console.error('[assistant/clear-chat] Error:', err);
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
