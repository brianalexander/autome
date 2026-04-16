import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyMultipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import { OrchestratorDB } from './db/database.js';
import { registerRoutes } from './api/routes.js';
import { websocketPlugin } from './api/websocket.js';
import { EventBus } from './events/bus.js';
import { ManualTriggerProvider } from './events/providers/manual.js';
import { AgentPool } from './acp/pool.js';
import { createProvider, initializeProviders } from './acp/provider/registry.js';
import { setDefaultProvider } from './agents/discovery.js';
import { runCrashRecovery } from './recovery.js';
import { launchWorkflow } from './workflow/launch.js';
import { cleanupOrphanTests } from './workflow/test-run-janitor.js';
import { startTestRunListener } from './workflow/test-run-listener.js';
import { initializeRegistry, nodeRegistry } from './nodes/registry.js';
import { loadPlugins } from './plugin/loader.js';
import { applyPluginNodeTypes, shutdownPlugins, syncPluginTemplates, trackLoadedPlugin } from './plugin/apply.js';
import {
  initTriggerLifecycle,
  activateWorkflowTriggers,
  createTriggerSubscriptions,
  deactivateAll as deactivateAllTriggers,
} from './engine/trigger-lifecycle.js';
import { config, DEFAULT_ACP_PROVIDER } from './config.js';

const PORT = config.port;

// Declared at module scope so signal handlers and start() share references.
// All are assigned inside start() so errors are covered by start().catch().
let db: OrchestratorDB;
let eventBus: EventBus;
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

async function start() {
  // Initialize database
  db = new OrchestratorDB();

  // Initialize event system
  eventBus = new EventBus();
  manualTrigger = new ManualTriggerProvider();
  eventBus.registerProvider(manualTrigger);

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
      const { restateError, validationError } = await launchWorkflow(db, workflow, event, nonTriggerStageIds, workflow.id, { initiatedBy: 'cron' });
      if (validationError) {
        console.error(`[event-bus] Payload validation failed for ${workflow.id}: ${validationError}`);
        return;
      }
      if (restateError) {
        console.error('[event-bus] Failed to start Restate workflow:', restateError);
      }
    } catch (err) {
      console.error('[event-bus] Error spawning instance:', err);
    }
  });

  // Initialize node type registry before accepting connections
  await initializeRegistry();

  // Discover plugins early so node types are available before any other setup
  const plugins = await loadPlugins();
  await applyPluginNodeTypes(plugins, nodeRegistry);

  // Discover and register custom ACP providers from ./providers/ and ~/.autome/providers/
  await initializeProviders();

  // Resolve the effective provider: DB setting takes priority, env var is fallback.
  // If neither is set, default to 'kiro' so the server starts up in a usable state
  // (the UI will prompt the user to configure a provider).
  const dbProviderName = db.getSetting('acpProvider');
  const effectiveProviderName = dbProviderName || config.acpProvider || DEFAULT_ACP_PROVIDER;

  // Initialize ACP provider and configure discovery
  const acpProvider = createProvider(effectiveProviderName);
  setDefaultProvider(acpProvider);

  // Regenerate per-provider agent files from canonical (agents/<name>/) on every
  // boot. The canonical is the source of truth; per-provider variants under
  // .claude/agents/, .kiro/agents/, etc. are gitignored build artifacts. This
  // hook keeps them in sync so editing canonical and restarting the server is
  // all you need to push prompt changes to the active provider — no manual
  // POST /api/agents/generate required.
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

  // Register plugins
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
  await app.register(registerRoutes, { db, eventBus, manualTrigger, authorPool, acpPool, assistantPool, plugins });

  // Sync plugin-defined templates into the DB (idempotent: create or update by source)
  await syncPluginTemplates(plugins, db);

  // Graceful shutdown hook
  app.addHook('onClose', async () => {
    console.log('Shutting down...');
    deactivateAllTriggers();
    stopTestRunListener?.();
    if (janitorInterval) clearInterval(janitorInterval);
    await shutdownPlugins().catch((err) => console.warn('[plugins] Shutdown error:', err));
    await eventBus.stopAll().catch(() => {});
    await authorPool?.terminateAll().catch(() => {});
    await acpPool?.terminateAll().catch(() => {});
    await assistantPool?.terminateAll().catch(() => {});
    db.close();
  });

  // Start event bus
  eventBus.startAll().catch((err) => console.error('[event-bus] Start error:', err));

  // Restore active workflow subscriptions and trigger executors from database
  const { data: workflows } = db.listWorkflows();
  for (const workflow of workflows) {
    if (workflow.active) {
      createTriggerSubscriptions(workflow, eventBus);
      // Activate trigger executors (e.g., cron intervals) for this workflow
      activateWorkflowTriggers(workflow).catch((err) =>
        console.error(`[trigger-lifecycle] Failed to activate triggers for workflow "${workflow.name}":`, err),
      );
      console.log(`Restored subscription for workflow "${workflow.name}"`);
    }
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);

  // Call plugin onReady hooks after the server is fully listening, and track
  // each plugin so its onClose hook fires during graceful shutdown.
  for (const plugin of plugins) {
    if (plugin.onReady) {
      try {
        await plugin.onReady({ nodeRegistry, eventBus });
      } catch (err) {
        console.warn(`[plugins] onReady error for "${plugin.name}":`, err);
      }
    }
    trackLoadedPlugin(plugin);
  }
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown on signals
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT');
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM');
  await app.close();
  process.exit(0);
});
