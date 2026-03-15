import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { discoverAgents, getAgentSpec } from '../../agents/discovery.js';
import { createProvider, createProviderAsync, listProviders } from '../../acp/provider/registry.js';
import { generateAgentConfigs } from '../../agents/adapter.js';
import { config } from '../../config.js';
import type { RouteDeps, SharedState } from './shared.js';
import { errorMessage } from '../../utils/errors.js';

const AgentNameParams = z.object({ name: z.string() });

const RegisterProviderBody = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const RegisterMCPServerBody = z
  .object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps, state: SharedState): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  // Agent discovery
  typedApp.get('/api/agents', async (request, reply) => {
    try {
      const agents = await discoverAgents();
      return agents;
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  typedApp.get(
    '/api/agents/:name',
    {
      schema: { params: AgentNameParams },
    },
    async (request, reply) => {
      try {
        const { name } = request.params;
        const agent = await getAgentSpec(name);
        if (!agent) return reply.code(404).send({ error: 'Agent not found' });
        return agent;
      } catch (err) {
        return reply.code(500).send({ error: errorMessage(err) });
      }
    },
  );

  // Event providers
  typedApp.get('/api/providers', async (request, reply) => {
    try {
      return db.listProviders();
    } catch (err) {
      console.error('GET /api/providers error:', err);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  typedApp.post(
    '/api/providers',
    {
      schema: { body: RegisterProviderBody },
    },
    async (request, reply) => {
      try {
        db.registerProvider(request.body as unknown as Parameters<typeof db.registerProvider>[0]);
        return reply.code(201).send(request.body);
      } catch (err) {
        console.error('POST /api/providers error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // MCP servers registry
  typedApp.get('/api/mcp-servers', async (request, reply) => {
    try {
      return db.listMCPServers();
    } catch (err) {
      console.error('GET /api/mcp-servers error:', err);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  typedApp.post(
    '/api/mcp-servers',
    {
      schema: { body: RegisterMCPServerBody },
    },
    async (request, reply) => {
      try {
        db.registerMCPServer(request.body);
        return reply.code(201).send(request.body);
      } catch (err) {
        console.error('POST /api/mcp-servers error:', err);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  // ACP provider info — active provider (singular)
  typedApp.get('/api/provider', async (_request, _reply) => {
    const dbProvider = db.getSetting('acpProvider');
    const envProvider = config.acpProvider;

    let source: 'settings' | 'env' | 'unconfigured';
    let providerName: string | null;

    if (dbProvider) {
      source = 'settings';
      providerName = dbProvider;
    } else if (envProvider) {
      source = 'env';
      providerName = envProvider;
    } else {
      source = 'unconfigured';
      providerName = null;
    }

    if (!providerName) {
      return { name: null, displayName: null, source };
    }

    try {
      const provider = createProvider(providerName);
      return { name: provider.name, displayName: provider.displayName, source };
    } catch {
      return { name: providerName, displayName: providerName, source };
    }
  });

  // ACP providers — list all available (built-in + plugins)
  typedApp.get('/api/acp-providers', async (_request, _reply) => {
    const providers = await listProviders();
    return providers;
  });

  // POST /api/agents/generate — regenerate provider-specific configs from canonical defs
  typedApp.post('/api/agents/generate', async (_request, reply) => {
    try {
      const providerName = db.getSetting('acpProvider') || config.acpProvider;
      if (!providerName) {
        return reply.code(400).send({ error: 'No ACP provider configured' });
      }
      const provider = await createProviderAsync(providerName);
      const result = await generateAgentConfigs(provider);
      return result;
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  // Node type registry
  typedApp.get('/api/node-types', async (_request, reply) => {
    try {
      const { nodeRegistry } = await import('../../nodes/registry.js');
      return nodeRegistry.getAllInfo();
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
