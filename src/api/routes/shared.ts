import type { OrchestratorDB } from '../../db/database.js';
import type { EventBus } from '../../events/bus.js';
import type { ManualTriggerProvider } from '../../events/providers/manual.js';
import type { AgentPool } from '../../acp/pool.js';
import { broadcast } from '../websocket.js';
import type { WorkflowDefinition } from '../../types/workflow.js';

// ---------------------------------------------------------------------------
// Route dependency injection
// ---------------------------------------------------------------------------

export interface RouteDeps {
  db: OrchestratorDB;
  eventBus: EventBus;
  manualTrigger: ManualTriggerProvider;
  authorPool?: AgentPool;
  acpPool?: AgentPool;
}

// ---------------------------------------------------------------------------
// Shared mutable state — created once, passed to all route modules
// ---------------------------------------------------------------------------

export interface SharedState {
  authorPool: AgentPool;
  acpPool: AgentPool;
  forceStoppedStages: Set<string>;
  signalledStages: Set<string>;
  authorDrafts: Map<string, WorkflowDefinition>;
  authorSpecSent: Set<string>;
  /** Active timeout handles keyed by "<instanceId>:<stageId>" */
  stageTimeouts: Map<string, ReturnType<typeof setTimeout>>;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Safely stringify a value for DB storage. Avoids double-encoding if already a string. */
export function safeStringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** RFC 7396 JSON Merge Patch — recursive merge, null deletes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergePatch<T extends Record<string, any>>(target: T, patch: Partial<T> | Record<string, unknown>): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const result = { ...target } as Record<string, unknown>;
  const patchObj = patch as Record<string, unknown>;
  for (const key of Object.keys(patchObj)) {
    if (patchObj[key] === null) {
      delete result[key];
    } else if (
      typeof patchObj[key] === 'object' &&
      !Array.isArray(patchObj[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergePatch(
        result[key] as Record<string, unknown>,
        patchObj[key] as Record<string, unknown>,
      );
    } else {
      result[key] = patchObj[key];
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

export function getDraft(db: OrchestratorDB, authorDrafts: Map<string, WorkflowDefinition>, workflowId: string): WorkflowDefinition {
  // Check memory cache first
  if (authorDrafts.has(workflowId)) return authorDrafts.get(workflowId)!;
  // Fall back to DB draft
  const dbDraft = db.getDraft(workflowId);
  if (dbDraft) {
    const typed = dbDraft as unknown as WorkflowDefinition;
    authorDrafts.set(workflowId, typed); // warm cache
    return typed;
  }
  // Fall back to published workflow
  const saved = db.getWorkflow(workflowId);
  if (saved) return saved;
  return {
    id: workflowId,
    name: 'Untitled Workflow',
    description: '',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
  } as WorkflowDefinition;
}

export function saveDraft(db: OrchestratorDB, authorDrafts: Map<string, WorkflowDefinition>, workflowId: string, draft: WorkflowDefinition | Record<string, unknown>) {
  // Save to DB (persistent)
  db.saveDraft(workflowId, draft as Record<string, unknown>);
  // Also keep in memory cache for fast access
  authorDrafts.set(workflowId, draft as WorkflowDefinition);
  broadcast('author:draft', { workflowId, definition: draft }, { workflowId });
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------

export {
  unwrapAcpOutput,
  wireAcpEvents,
  getValidAgentIds,
  validateAgentId,
  ensureSession,
  buildConversationHistory,
  sendChatMessage,
  initSessionCull,
} from './agent-utils.js';
export type {
  WireAcpEventsOpts,
  SessionConfig,
  SendMessageOpts,
} from './agent-utils.js';

export {
  validateStageConfig,
  validateAllStagesConfig,
  validateGraphStructure,
} from './validation.js';
export type { GraphValidationResult } from './validation.js';
