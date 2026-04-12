import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AgentPool } from '../acp/pool.js';
import type { RouteDeps, SharedState } from './routes/shared.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import { initSessionCull, loadDraftAliases } from './routes/shared.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerInstanceRoutes } from './routes/instances.js';
import { registerDraftRoutes } from './routes/draft.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTestRunRoutes } from './routes/test-runs.js';

// Re-export RouteDeps so existing imports from './routes.js' still work
export type { RouteDeps } from './routes/shared.js';

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const authorPool = deps.authorPool ?? new AgentPool();
  const acpPool = deps.acpPool ?? new AgentPool();

  // Pre-warm the draft cache from DB so drafts survive server restarts
  const authorDrafts = new Map<string, WorkflowDefinition>();
  for (const { workflowId } of deps.db.listDrafts()) {
    const draft = deps.db.getDraft(workflowId);
    if (draft) authorDrafts.set(workflowId, draft as unknown as WorkflowDefinition);
  }

  // Pre-warm draft aliases so temp IDs resolve correctly after restarts
  loadDraftAliases(deps.db.listDraftAliases());

  const state: SharedState = {
    authorPool,
    acpPool,
    forceStoppedStages: new Set<string>(),
    signalledStages: new Set<string>(),
    authorDrafts,
    authorSpecSent: new Set<string>(),
    stageTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
  };

  // Initialize session culling
  initSessionCull(authorPool, deps.db);

  // Register all route modules
  registerWorkflowRoutes(app, deps, state);
  registerInstanceRoutes(app, deps, state);
  registerDraftRoutes(app, deps, state);
  registerInternalRoutes(app, deps, state);
  registerAgentRoutes(app, deps, state);
  registerWebhookRoutes(app, deps, state);
  registerSettingsRoutes(app, deps);
  registerTestRunRoutes(app, deps);

  // Health endpoint
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  typedApp.get('/api/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
