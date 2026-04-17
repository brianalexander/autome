import type { OrchestratorDB } from '../../db/database.js';
import type { EventBus } from '../../events/bus.js';
import type { ManualTriggerProvider } from '../../events/providers/manual.js';
import type { AgentPool } from '../../acp/pool.js';
import { broadcast } from '../websocket.js';
import type { WorkflowDefinition } from '../../types/workflow.js';
import type { LoadedPlugin } from '../../plugin/types.js';
import type { WorkflowRunner } from '../../engine/runner.js';

// ---------------------------------------------------------------------------
// Route dependency injection
// ---------------------------------------------------------------------------

export interface RouteDeps {
  db: OrchestratorDB;
  eventBus: EventBus;
  manualTrigger: ManualTriggerProvider;
  runner: WorkflowRunner;
  authorPool?: AgentPool;
  acpPool?: AgentPool;
  assistantPool?: AgentPool;
  /** Loaded plugins — consumed by registerRoutes to attach plugin routes */
  plugins?: LoadedPlugin[];
}

// ---------------------------------------------------------------------------
// Shared mutable state — created once, passed to all route modules
// ---------------------------------------------------------------------------

export interface SharedState {
  runner: WorkflowRunner;
  authorPool: AgentPool;
  acpPool: AgentPool;
  assistantPool: AgentPool;
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
// Draft ID aliasing
// ---------------------------------------------------------------------------

// Maps old temp IDs → canonical workflow IDs. Populated when a workflow is
// saved (temp → real UUID), so the author agent's MCP server transparently
// resolves tool calls using the old temp ID to the right workflow without
// needing to restart.
const draftAliases = new Map<string, string>();

export function registerDraftAlias(fromId: string, toId: string): void {
  draftAliases.set(fromId, toId);
}

export function resolveDraftId(id: string): string {
  return draftAliases.get(id) || id;
}

export function loadDraftAliases(aliases: Array<{ fromId: string; toId: string }>): void {
  for (const { fromId, toId } of aliases) {
    draftAliases.set(fromId, toId);
  }
}

// ---------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------

export function getDraft(db: OrchestratorDB, authorDrafts: Map<string, WorkflowDefinition>, workflowId: string): WorkflowDefinition {
  const canonicalId = resolveDraftId(workflowId);
  // Check memory cache first
  if (authorDrafts.has(canonicalId)) return authorDrafts.get(canonicalId)!;
  // Fall back to DB draft
  const dbDraft = db.getDraft(canonicalId);
  if (dbDraft) {
    const typed = dbDraft as unknown as WorkflowDefinition;
    authorDrafts.set(canonicalId, typed); // warm cache
    return typed;
  }
  // Fall back to published workflow
  const saved = db.getWorkflow(canonicalId);
  if (saved) return saved;
  return {
    id: canonicalId,
    name: 'Untitled Workflow',
    description: '',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
  } as WorkflowDefinition;
}

export function saveDraft(db: OrchestratorDB, authorDrafts: Map<string, WorkflowDefinition>, workflowId: string, draft: WorkflowDefinition | Record<string, unknown>) {
  const canonicalId = resolveDraftId(workflowId);
  // Save to DB (persistent)
  db.saveDraft(canonicalId, draft as Record<string, unknown>);
  // Also keep in memory cache for fast access
  authorDrafts.set(canonicalId, draft as WorkflowDefinition);
  // Broadcast to canonical ID subscribers
  broadcast('author:draft', { workflowId: canonicalId, definition: draft }, { workflowId: canonicalId });
  // Also broadcast to the original (temp) ID so any subscribers on the old ID
  // (e.g. the frontend watching the temp draft) receive the update too
  if (canonicalId !== workflowId) {
    broadcast('author:draft', { workflowId, definition: draft }, { workflowId });
  }
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
