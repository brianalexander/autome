import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from './shared.js';
import { errorMessage } from '../../utils/errors.js';
import { createProviderAsync } from '../../acp/provider/registry.js';
import { generateAgentConfigs } from '../../agents/adapter.js';
import { setDefaultProvider } from '../../agents/discovery.js';

const KeyParams = z.object({ key: z.string() });
const SetSettingBody = z.object({ value: z.string() });

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // GET /api/settings — returns all settings
  typedApp.get('/api/settings', async (_request, reply) => {
    try {
      return db.getAllSettings();
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // GET /api/settings/:key — returns single setting
  typedApp.get(
    '/api/settings/:key',
    { schema: { params: KeyParams } },
    async (request, reply) => {
      try {
        const { key } = request.params;
        const value = db.getSetting(key);
        if (value === null) return reply.code(404).send({ error: 'Setting not found' });
        return { key, value };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // PUT /api/settings/:key — update setting
  typedApp.put(
    '/api/settings/:key',
    { schema: { params: KeyParams, body: SetSettingBody } },
    async (request, reply) => {
      try {
        const { key } = request.params;
        const { value } = request.body;
        db.setSetting(key, value);

        if (key === 'acpProvider') {
          // Update the default provider used by agent discovery and generate configs
          createProviderAsync(value)
            .then((provider) => {
              setDefaultProvider(provider);
              console.log(`[settings] Switched ACP provider to "${value}"`);
              return generateAgentConfigs(provider);
            })
            .then((result) => {
              console.log(`[settings] Generated agent configs for provider "${value}":`, result);
            })
            .catch((err) => {
              console.warn(`[settings] Failed to switch ACP provider to "${value}":`, err);
            });
        }

        return { key, value };
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // DELETE /api/settings/:key — delete setting
  typedApp.delete(
    '/api/settings/:key',
    { schema: { params: KeyParams } },
    async (request, reply) => {
      try {
        const { key } = request.params;
        db.deleteSetting(key);
        return reply.code(204).send();
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );
}
