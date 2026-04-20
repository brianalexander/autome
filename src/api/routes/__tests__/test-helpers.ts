import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { OrchestratorDB } from '../../../db/database.js';
import { EventBus } from '../../../events/bus.js';
import { ManualTriggerProvider } from '../../../events/providers/manual.js';
import { AgentPool } from '../../../acp/pool.js';
import { WorkflowRunner } from '../../../engine/runner.js';
import { registerWorkflowRoutes } from '../workflows.js';
import { registerInstanceRoutes } from '../instances.js';
import type { WorkflowDefinition } from '../../../types/workflow.js';
import type { SharedState } from '../shared.js';

export async function buildTestApp() {
  const db = new OrchestratorDB(':memory:');

  const eventBus = new EventBus();
  const manualTrigger = new ManualTriggerProvider();
  eventBus.registerProvider(manualTrigger);

  const acpPool = new AgentPool();
  const authorPool = new AgentPool();
  const runner = new WorkflowRunner(db, eventBus, 'http://127.0.0.1:3001');

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps = { db, eventBus, runner, manualTrigger, acpPool, authorPool, orchestratorPort: 3001 };

  const authorDrafts = new Map<string, WorkflowDefinition>();
  const assistantPool = new AgentPool();
  const state: SharedState = {
    runner,
    authorPool,
    acpPool,
    assistantPool,
    forceStoppedStages: new Set<string>(),
    signalledStages: new Set<string>(),
    authorDrafts,
    authorSpecSent: new Set<string>(),
    stageTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
  };

  registerWorkflowRoutes(app, deps, state);
  registerInstanceRoutes(app, deps, state);

  await app.ready();

  return { app, db };
}
