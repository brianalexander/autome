import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';
import { errorMessage } from '../../utils/errors.js';

const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, { message: 'Must match /^[A-Z][A-Z0-9_]*$/' });

export function registerSecretsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const svc = deps.secretsService;

  if (!svc) {
    console.warn('[secrets] SecretsService not provided — secret routes disabled');
    return;
  }

  // GET /api/secrets — list (no values)
  typedApp.get('/api/secrets', async () => svc.list());

  // POST /api/secrets — create { name, value, description? }
  typedApp.post(
    '/api/secrets',
    {
      schema: {
        body: z.object({
          name: SecretName,
          value: z.string().min(1),
          description: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      try {
        return svc.create(req.body.name, req.body.value, req.body.description);
      } catch (err) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
    },
  );

  // PUT /api/secrets/:name — update value { value, description? }
  typedApp.put(
    '/api/secrets/:name',
    {
      schema: {
        params: z.object({ name: SecretName }),
        body: z.object({ value: z.string().min(1), description: z.string().optional() }),
      },
    },
    async (req, reply) => {
      try {
        return svc.update(req.params.name, req.body.value, req.body.description);
      } catch (err) {
        return reply.code(404).send({ error: errorMessage(err) });
      }
    },
  );

  // DELETE /api/secrets/:name
  typedApp.delete(
    '/api/secrets/:name',
    {
      schema: { params: z.object({ name: SecretName }) },
    },
    async (req, reply) => {
      const deleted = svc.delete(req.params.name);
      if (!deleted) return reply.code(404).send({ error: 'Not found' });
      return reply.code(204).send();
    },
  );
}
