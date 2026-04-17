import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorDB } from './db/database.js';
import { registerRoutes } from './api/routes.js';
import { websocketPlugin } from './api/websocket.js';
import { EventBus } from './events/bus.js';
import { ManualTriggerProvider } from './events/providers/manual.js';
import { AgentPool } from './acp/pool.js';
import { WorkflowRunner } from './engine/runner.js';
import { createProvider, initializeProviders } from './acp/provider/registry.js';
import { setDefaultProvider } from './agents/discovery.js';
import { runCrashRecovery } from './recovery.js';
import { launchWorkflow } from './workflow/launch.js';
import { cleanupOrphanTests } from './workflow/test-run-janitor.js';
import { startTestRunListener } from './workflow/test-run-listener.js';
import { initializeRegistry, nodeRegistry } from './nodes/registry.js';
import { loadPlugins } from './plugin/loader.js';
import { applyPlugins } from './plugin/apply.js';
import {
  initTriggerLifecycle,
  activateWorkflowTriggers,
  createTriggerSubscriptions,
  deactivateAll as deactivateAllTriggers,
} from './engine/trigger-lifecycle.js';
import { DEFAULT_ACP_PROVIDER } from './config.js';
import type { ResolvedConfig } from './config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveFrontendDistPath(): string {
  // When compiled: dist/server-start.js -> ../frontend/dist
  // When run via tsx from src/: src/server-start.ts -> ../frontend/dist
  return resolve(__dirname, '../frontend/dist');
}

/**
 * Start the Fastify server with the given resolved configuration.
 * Returns the Fastify instance (useful for graceful shutdown).
 */
export async function startServer(resolvedConfig: ResolvedConfig) {
  // Declared at function scope so signal handlers share references.
  let db: OrchestratorDB;
  let eventBus: EventBus;
  let runner: WorkflowRunner;
  let manualTrigger: ManualTriggerProvider;
  let authorPool: AgentPool;
  let acpPool: AgentPool;
  let assistantPool: AgentPool;
  let stopTestRunListener: (() => void) | undefined;
  let janitorInterval: ReturnType<typeof setInterval> | undefined;

  // Create Fastify app
  const app = Fastify({ logger: false });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Initialize database using resolved config path
  db = new OrchestratorDB(resolvedConfig.databasePath);

  // Initialize event system
  eventBus = new EventBus();
  manualTrigger = new ManualTriggerProvider();
  eventBus.registerProvider(manualTrigger);

  // Initialize workflow runner
  runner = new WorkflowRunner(db, eventBus);

  // Initialize trigger lifecycle manager with the event bus
  initTriggerLifecycle(eventBus);

  // Listen for trigger events and spawn workflow instances
  eventBus.on('trigger', async ({ subscription, event }) => {
    try {
      const workflow = db.getWorkflow(subscription.workflowDefinitionId);
      if (!workflow || !workflow.active) return;

      const nonTriggerStageIds = workflow.stages
        .filter((s) => !nodeRegistry.isTriggerType(s.type))
        .map((s) => s.id);
      const { runnerError, validationError } = await launchWorkflow(
        db, runner, workflow, event, nonTriggerStageIds, workflow.id, { initiatedBy: 'cron' },
      );
      if (validationError) {
        console.error(`[event-bus] Payload validation failed for ${workflow.id}: ${validationError}`);
        return;
      }
      if (runnerError) {
        console.error('[event-bus] Failed to start workflow:', runnerError);
      }
    } catch (err) {
      console.error('[event-bus] Error spawning instance:', err);
    }
  });

  // Initialize node type registry before accepting connections
  await initializeRegistry();

  // Discover plugins early so node types are available before any other setup
  const { loaded: plugins, failures: pluginFailures } = await loadPlugins();
  if (pluginFailures.length > 0) {
    for (const f of pluginFailures) {
      console.warn(`[plugins] Failed to load ${f.path}: ${f.error.message}`);
    }
  }
  await applyPlugins(plugins, nodeRegistry, db);

  // Discover and register custom ACP providers from ./providers/ and ~/.autome/providers/
  await initializeProviders();

  // Resolve the effective provider: DB setting takes priority, config/env is fallback.
  // If neither is set, default to 'kiro' so the server starts up in a usable state.
  const dbProviderName = db.getSetting('acpProvider');
  const effectiveProviderName = dbProviderName || resolvedConfig.acpProvider || DEFAULT_ACP_PROVIDER;

  // Initialize ACP provider and configure discovery
  const acpProvider = createProvider(effectiveProviderName);
  setDefaultProvider(acpProvider);

  // Regenerate per-provider agent files from canonical (agents/<name>/) on every boot.
  try {
    const { generateAgentConfigs } = await import('./agents/adapter.js');
    const result = await generateAgentConfigs(acpProvider);
    if (result.generated.length > 0) {
      console.log(`[agents] Regenerated ${result.generated.length} canonical agent(s) for ${acpProvider.name}: ${result.generated.join(', ')}`);
    }
    if (result.errors.length > 0) {
      console.warn('[agents] Some canonical agents failed to regenerate:', result.errors);
    }
  } catch (err) {
    console.warn('[agents] Canonical agent regeneration skipped:', err instanceof Error ? err.message : String(err));
  }

  // Initialize ACP process pools
  authorPool = new AgentPool({ provider: acpProvider });
  acpPool = new AgentPool({ provider: acpProvider });
  assistantPool = new AgentPool({ provider: acpProvider });

  // Run crash recovery before accepting connections
  await runCrashRecovery(db, acpProvider);

  // Start test-run listener (before routes so it's ready when first event fires)
  stopTestRunListener = startTestRunListener({ db, authorPool });

  // Initial janitor sweep + hourly interval
  try { cleanupOrphanTests(db); } catch (err) { console.error('[janitor] Initial sweep failed:', err); }
  janitorInterval = setInterval(() => {
    try { cleanupOrphanTests(db); } catch (err) { console.error('[janitor] Periodic sweep failed:', err); }
  }, 60 * 60 * 1000);

  // Register Fastify plugins
  await app.register(fastifyCors);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Autome API',
        description: 'AI Agent Workflow Orchestrator',
        version: '0.1.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // Serve OpenAPI spec
  app.get('/api/openapi.json', async () => {
    return app.swagger();
  });

  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max bundle
  await app.register(fastifyWebSocket);

  // Register WebSocket plugin
  await app.register(websocketPlugin);

  // Register routes with all dependencies (plugins get routes registered inside)
  await app.register(registerRoutes, { db, eventBus, runner, manualTrigger, authorPool, acpPool, assistantPool, plugins });

  // Production: serve bundled frontend static files
  if (resolvedConfig.mode === 'production') {
    const frontendPath = resolveFrontendDistPath();
    if (!existsSync(frontendPath)) {
      console.warn(
        '[server] Production mode but frontend/dist not found. ' +
        'Run `npm run build:all` first.',
      );
    } else {
      await app.register(fastifyStatic, {
        root: frontendPath,
        prefix: '/',
      });

      // SPA fallback — unknown routes that aren't /api or /ws get index.html
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
          return reply.code(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html');
      });
    }
  }

  // Graceful shutdown hook
  app.addHook('onClose', async () => {
    console.log('Shutting down...');
    deactivateAllTriggers();
    stopTestRunListener?.();
    if (janitorInterval) clearInterval(janitorInterval);
    await runner?.shutdown().catch((err) => console.warn('[runner] Shutdown error:', err));
    await eventBus.stopAll().catch(() => {});
    await authorPool?.terminateAll().catch(() => {});
    await acpPool?.terminateAll().catch(() => {});
    await assistantPool?.terminateAll().catch(() => {});
    db.close();
  });

  // Start event bus
  eventBus.startAll().catch((err) => console.error('[event-bus] Start error:', err));

  // Resume any non-terminal workflow instances that survived the previous restart
  await runner.resumeAllFromDB().catch((err) =>
    console.error('[runner] resumeAllFromDB error:', err),
  );

  // Restore active workflow subscriptions and trigger executors from database
  const { data: workflows } = db.listWorkflows();
  for (const workflow of workflows) {
    if (workflow.active) {
      createTriggerSubscriptions(workflow, eventBus);
      activateWorkflowTriggers(workflow).catch((err) =>
        console.error(`[trigger-lifecycle] Failed to activate triggers for workflow "${workflow.name}":`, err),
      );
      console.log(`Restored subscription for workflow "${workflow.name}"`);
    }
  }

  await app.listen({ port: resolvedConfig.port, host: resolvedConfig.host });
  console.log(`Server running on ${resolvedConfig.host}:${resolvedConfig.port}`);
  console.log(`WebSocket available at ws://localhost:${resolvedConfig.port}/ws`);

  // Register signal handlers for graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return app;
}
