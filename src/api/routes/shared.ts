import { config as appConfig } from '../../config.js';
import type { OrchestratorDB } from '../../db/database.js';
import type { EventBus } from '../../events/bus.js';
import type { ManualTriggerProvider } from '../../events/providers/manual.js';
import type { AgentPool } from '../../acp/pool.js';
import type { AcpClient } from '../../acp/client.js';
import { broadcast, type BroadcastScope } from '../websocket.js';
import { SessionManager } from '../../acp/session-manager.js';
import { discoverAgents } from '../../agents/discovery.js';
import { nodeRegistry } from '../../nodes/registry.js';
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

/** Unwrap ACP transport format ({items:[{Json:{content:[{type:"text",text:"..."}]}}]}) to plain text.
 *  Stores what the LLM actually sees, not the wire format. */
export function unwrapAcpOutput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  const obj =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!obj) return raw;

  // ACP wrapper: { items: [{ Json: { content: [{ type: "text", text: "..." }] } }] }
  if (obj.items && Array.isArray(obj.items)) {
    const texts: string[] = [];
    for (const item of obj.items) {
      if (item?.Json?.content && Array.isArray(item.Json.content)) {
        for (const c of item.Json.content) {
          if (c?.text) texts.push(c.text);
        }
      } else if (item?.Text) {
        texts.push(item.Text);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }

  // MCP content array: [{ type: "text", text: "..." }]
  if (Array.isArray(obj) && (obj[0] as Record<string, unknown> | undefined)?.text) {
    return (obj as Array<{ text?: unknown }>).map((c) => c.text).join('\n');
  }

  return raw;
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
// ACP event wiring — shared by runtime agent stages and author chat sessions
// ---------------------------------------------------------------------------

export interface WireAcpEventsOpts {
  instanceId: string;
  stageId: string;
  iteration: number;
  eventPrefix: 'agent' | 'author';
  filterPayload: Record<string, string>;
  /** Broadcast scope for filtering — instance or workflow level. */
  scope?: BroadcastScope;
  cullKey?: string;
  onTurnEnd?: () => void;
}

export function wireAcpEvents(client: AcpClient, db: OrchestratorDB, opts: WireAcpEventsOpts) {
  const { instanceId, stageId, iteration, eventPrefix, filterPayload, scope, cullKey, onTurnEnd } = opts;

  // In-memory segments array for correct interleaving of text + tool references
  const segments: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }> = [];
  let pendingText = '';
  let persistPending = false;

  const flushText = () => {
    if (!pendingText) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'text') {
      last.content += pendingText;
    } else {
      if (last && last.type === 'tool') {
        const swept = db.sweepToolCallStatuses(instanceId, stageId, iteration, ['in_progress', 'pending'], 'completed');
        if (swept > 0) {
          broadcast(`${eventPrefix}:tools_swept`, { ...filterPayload, toStatus: 'completed' }, scope);
        }
      }
      segments.push({ type: 'text', content: pendingText });
    }
    const textToWrite = pendingText;
    pendingText = '';
    if (!persistPending) {
      persistPending = true;
      setImmediate(() => {
        persistPending = false;
        db.appendToLastTextSegment(instanceId, stageId, iteration, textToWrite);
      });
    }
  };

  client.on('agent_message_chunk', (content: Record<string, unknown>) => {
    const text = content?.type === 'text' ? (content.text as string) : '';
    if (!text) return;
    broadcast(`${eventPrefix}:chunk`, { ...filterPayload, text }, scope);
    pendingText += text;
    if (!persistPending) {
      persistPending = true;
      setImmediate(() => {
        persistPending = false;
        flushText();
      });
    }
  });

  interface ToolCallEventData {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
  }

  client.on('tool_call', (data: ToolCallEventData) => {
    flushText();
    // Extract parent tool use ID for sub-agent child grouping
    const meta = (data as any)?._meta?.claudeCode;
    const parentToolUseId = meta?.parentToolUseId as string | undefined;

    segments.push({ type: 'tool', toolCallId: data.toolCallId });
    db.appendSegment(instanceId, stageId, iteration, 'tool', undefined, data.toolCallId);
    const status = data.rawInput || data.kind ? 'in_progress' : 'pending';
    db.upsertToolCall({
      id: data.toolCallId,
      instanceId,
      stageId,
      iteration,
      title: data.title || undefined,
      kind: data.kind || undefined,
      status,
      rawInput: safeStringify(data.rawInput),
      parentToolUseId: parentToolUseId || undefined,
    });
    broadcast(`${eventPrefix}:tool_call`, { ...filterPayload, ...data, parentToolUseId, status }, scope);
  });

  client.on('tool_call_update', (data: ToolCallEventData) => {
    // Unwrap ACP transport format to store what the model actually sees
    const cleanOutput = unwrapAcpOutput(data.rawOutput);
    // Extract parent tool use ID for sub-agent child grouping
    const updateMeta = (data as any)?._meta?.claudeCode;
    const parentToolUseId = updateMeta?.parentToolUseId as string | undefined;

    db.upsertToolCall({
      id: data.toolCallId,
      instanceId,
      stageId,
      iteration,
      kind: data.kind,
      status: data.status || 'completed',
      rawInput: safeStringify(data.rawInput),
      rawOutput: safeStringify(cleanOutput),
      parentToolUseId: parentToolUseId || undefined,
    });
    broadcast(`${eventPrefix}:tool_result`, { ...filterPayload, ...data, rawOutput: cleanOutput, parentToolUseId }, scope);
  });

  client.on('metadata', (data: { contextUsagePercentage?: number }) => {
    if (data?.contextUsagePercentage != null) {
      broadcast(`${eventPrefix}:context_usage`, { ...filterPayload, percentage: data.contextUsagePercentage }, scope);
    }
  });

  client.on('model_info', (data: { model: string }) => {
    broadcast(`${eventPrefix}:model_info`, { ...filterPayload, model: data.model }, scope);
    // Persist model name alongside the session so it survives page reloads
    const dbKey = cullKey || `${instanceId}:${stageId}`;
    console.log(`[model_info] Persisting model="${data.model}" for key="${dbKey}"`);
    try { db.updateAcpSessionModel(dbKey, data.model); } catch (err) { console.error(`[model_info] Failed to persist:`, err); }
  });

  client.on('turn_end', () => {
    flushText();
    db.sweepToolCallStatuses(instanceId, stageId, iteration, ['in_progress', 'pending'], 'completed');
    broadcast(`${eventPrefix}:done`, filterPayload, scope);
    if (cullKey) _sessionManager?.onTurnEnd(cullKey);
    onTurnEnd?.();
  });

  // MCP server readiness events
  interface McpServerEventData {
    serverName?: string;
    total?: number;
    expected?: number | null;
    error?: string;
  }

  client.on('mcp_server_ready', (data: McpServerEventData) => {
    broadcast(
      `${eventPrefix}:mcp_status`,
      {
        ...filterPayload,
        event: 'server_ready',
        serverName: data.serverName,
        serversReady: data.total,
        serversExpected: data.expected,
      },
      scope,
    );
  });

  client.on('mcp_server_failed', (data: McpServerEventData) => {
    broadcast(
      `${eventPrefix}:mcp_status`,
      {
        ...filterPayload,
        event: 'server_failed',
        serverName: data.serverName,
        error: data.error,
        serversExpected: data.expected,
      },
      scope,
    );
  });

  client.on('close', ({ code, signal, stderr }: { code: number | null; signal: string | null; stderr?: string }) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      broadcast(
        `${eventPrefix}:error`,
        {
          ...filterPayload,
          error: `Agent process exited unexpectedly (code: ${code}, signal: ${signal})`,
          stderr: stderr?.slice(-500),
        },
        scope,
      );
    }
  });

  client.on('stderr', (text: string) => {
    if (text.trim().length > 10) {
      broadcast(`${eventPrefix}:stderr`, { ...filterPayload, text: text.trim() }, scope);
    }
  });

  client.on('error', (err: Error) => {
    console.error(`[${eventPrefix}] Error for ${instanceId}:${stageId}:`, err);
    broadcast(`${eventPrefix}:error`, { ...filterPayload, error: `Agent process error: ${err.message}` }, scope);
  });

  // Broadcast model info so WS clients always get it — check client first, then DB fallback.
  const dbKey = cullKey || `${instanceId}:${stageId}`;
  const storedModel = db.getAcpSession(dbKey)?.model_name;
  const modelName = client.modelName || storedModel || null;
  if (modelName) {
    broadcast(`${eventPrefix}:model_info`, { ...filterPayload, model: modelName }, scope);
    // Persist to DB if not already stored
    if (!storedModel) {
      try { db.updateAcpSessionModel(dbKey, modelName); } catch { /* session may not exist yet */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Stage config validation against NodeTypeSpec.configSchema
// ---------------------------------------------------------------------------

/**
 * Validate a stage's config against the node type's configSchema.
 * Returns an array of error strings (empty = valid).
 */
export function validateStageConfig(type: string, config: Record<string, unknown>): string[] {
  const zodSchema = nodeRegistry.getConfigZodSchema(type);
  if (!zodSchema) {
    // Unknown type or no configSchema — skip validation (third-party nodes may not be registered yet)
    const spec = nodeRegistry.get(type);
    if (!spec) return [`Unknown node type "${type}"`];
    return []; // Known type but no schema = no validation
  }

  const result = zodSchema.safeParse(config);
  if (result.success) return [];

  return result.error.issues.map(issue =>
    `${issue.path.join('.')}: ${issue.message}`
  );
}

/**
 * Validate all stages in a stages array. Returns a combined list of errors.
 * Skips trigger stages (they don't have user-facing config).
 */
export function validateAllStagesConfig(stages: Array<{ type?: string; config?: Record<string, unknown> }>): string[] {
  const errors: string[] = [];
  for (const stage of stages) {
    if (!stage.type || nodeRegistry.isTriggerType(stage.type)) continue;
    if (!stage.config) continue;
    errors.push(...validateStageConfig(stage.type, stage.config));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Graph structure validation
// ---------------------------------------------------------------------------

export interface GraphValidationResult {
  errors: string[]; // Blocking issues
  warnings: string[]; // Non-blocking issues
}

export function validateGraphStructure(
  stages: Array<{ id: string; type: string }>,
  edges: Array<{ source: string; target: string }>,
): GraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stageIds = new Set(stages.map((s) => s.id));

  // 1. Duplicate stage IDs
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.id)) errors.push(`Duplicate stage ID: "${stage.id}"`);
    seen.add(stage.id);
  }

  // 2. Edge source/target references must match existing stages
  for (const edge of edges) {
    if (!stageIds.has(edge.source)) errors.push(`Edge source "${edge.source}" does not match any stage`);
    if (!stageIds.has(edge.target)) errors.push(`Edge target "${edge.target}" does not match any stage`);
  }

  // 3. At least one trigger stage
  const triggerStages = stages.filter((s) => nodeRegistry.isTriggerType(s.type));
  if (triggerStages.length === 0) errors.push('Workflow must have at least one trigger stage');

  // 4. Reachability check (warning only) — BFS from all triggers
  const reachable = new Set<string>();
  const queue = triggerStages.map((t) => t.id);
  for (const id of queue) reachable.add(id);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.source === current && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  const unreachable = stages.filter((s) => !reachable.has(s.id) && !nodeRegistry.isTriggerType(s.type));
  if (unreachable.length > 0) {
    warnings.push(`Unreachable stages: ${unreachable.map((s) => s.id).join(', ')}`);
  }

  return { errors, warnings };
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
// Agent ID validation cache
// ---------------------------------------------------------------------------

let cachedAgentNames: Set<string> | null = null;
let agentCacheTime = 0;

export async function getValidAgentIds(): Promise<Set<string>> {
  if (cachedAgentNames && Date.now() - agentCacheTime < 30_000) return cachedAgentNames;
  try {
    const agents = await discoverAgents();
    cachedAgentNames = new Set(agents.map((a) => a.name));
    agentCacheTime = Date.now();
  } catch {
    if (!cachedAgentNames) cachedAgentNames = new Set();
  }
  return cachedAgentNames;
}

export function validateAgentId(agentId: string | undefined, validIds: Set<string>): string | null {
  if (!agentId) return null;
  if (!validIds.has(agentId)) {
    return `Unknown agent "${agentId}". Available agents: ${[...validIds].join(', ')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified chat session management
// ---------------------------------------------------------------------------

export interface SessionConfig {
  pool: AgentPool;
  instanceId: string;
  stageId: string;
  iteration: number;
  agentId: string;
  overrides?: {
    model?: string;
    additional_prompt?: string;
    additional_tools?: string[];
    additional_mcp_servers?: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
  };
  eventPrefix: 'agent' | 'author';
  filterPayload: Record<string, string>;
  /** Broadcast scope for filtering events to subscribed clients. */
  scope?: BroadcastScope;
  cullKey?: string;
}

/** Returns hasContext=true when the agent already has the full conversation
 *  (either still running in memory, or kiro-cli's loadSession succeeded). */
export async function ensureSession(
  config: SessionConfig,
  db: OrchestratorDB,
): Promise<{ client: AcpClient; hasContext: boolean }> {
  const { pool, instanceId, stageId, iteration, agentId, overrides, eventPrefix, filterPayload, scope, cullKey } =
    config;

  // Already running in memory — has full conversation context
  const existing = pool.getClient(instanceId, stageId);
  if (existing) return { client: existing, hasContext: true };

  // Spawn a new process, attempting to resume via stored session ID
  // Skip resume if session was explicitly destroyed (user clicked "New Session")
  const sessionKey = cullKey || `${instanceId}:${stageId}`;
  const stored = db.getAcpSession(sessionKey);
  const acpSessionId = stored?.status === 'destroyed' ? undefined : stored?.session_id;

  console.log(
    `[ensure-session] ${acpSessionId ? 'Attempting resume' : 'Spawning'} ${agentId} for ${instanceId}:${stageId}`,
  );

  const { client, sessionLoaded } = await pool.spawn({
    instanceId,
    stageId,
    acpSessionId,
    config: { agentId, overrides },
    orchestratorPort: appConfig.port,
  });

  wireAcpEvents(client, db, { instanceId, stageId, iteration, eventPrefix, filterPayload, scope, cullKey });

  // Store session for future resume
  const sid = pool.getSessionId(instanceId, stageId);
  if (sid) db.upsertAcpSession(sessionKey, sid, client.pid);

  // hasContext is true only if kiro-cli successfully loaded the session
  return { client, hasContext: sessionLoaded };
}

/** Build conversation history from persisted segments */
export function buildConversationHistory(
  db: OrchestratorDB,
  instanceId: string,
  stageId: string,
  iteration: number,
): string | null {
  const priorSegments = db.getSegments(instanceId, stageId, iteration);
  if (priorSegments.length === 0) return null;
  const parts: string[] = ['<conversation_history>'];
  for (const seg of priorSegments) {
    if (seg.segment_type === 'user') {
      parts.push(`[user]: ${seg.content || ''}`);
    } else if (seg.segment_type === 'text' && seg.content) {
      parts.push(`[assistant]: ${seg.content}`);
    }
  }
  parts.push('</conversation_history>');
  return parts.join('\n');
}

export interface SendMessageOpts {
  config: SessionConfig;
  message: string;
  /** Extra context to prepend (e.g. workflow state for author). Only sent on first turn of a fresh session. */
  buildContext?: () => Promise<string | null>;
}

export async function sendChatMessage(opts: SendMessageOpts, db: OrchestratorDB): Promise<void> {
  const { config, message, buildContext } = opts;
  const { instanceId, stageId, iteration, eventPrefix, filterPayload, scope, cullKey } = config;

  const { client, hasContext } = await ensureSession(config, db);

  if (cullKey) _sessionManager?.onTurnStart(cullKey);

  // Build the prompt — prepend context + history unless the agent already has
  // the full conversation (either still running, or kiro-cli loadSession succeeded)
  const contextParts: string[] = [];
  if (!hasContext) {
    if (buildContext) {
      const ctx = await buildContext();
      if (ctx) contextParts.push(ctx);
    }
    const history = buildConversationHistory(db, instanceId, stageId, iteration);
    if (history) contextParts.push(history);
  }

  // Persist user message as a segment
  db.appendSegment(instanceId, stageId, iteration, 'user', message);
  broadcast(`${eventPrefix}:user_message`, { ...filterPayload, message }, scope);

  const enrichedMessage =
    contextParts.length > 0 ? `${contextParts.join('\n\n')}\n\nUser message: ${message}` : message;

  client.prompt(enrichedMessage).catch((err: Error) => {
    console.error(`[chat] Prompt failed for ${instanceId}:${stageId}:`, err);
    broadcast(`${eventPrefix}:error`, { ...filterPayload, error: err.message }, scope);
  });
}

// ---------------------------------------------------------------------------
// Session cull initialization
// ---------------------------------------------------------------------------

/** Module-level SessionManager instance — initialized once by initSessionCull */
let _sessionManager: SessionManager | null = null;

export function initSessionCull(authorPool: AgentPool, db: OrchestratorDB) {
  _sessionManager = new SessionManager();
  _sessionManager.setDestroyFn((key) => {
    const [type, id] = key.split(':', 2);
    if (type === 'author' && id) {
      authorPool.terminate('author', id);
      db.markAcpSessionStatus(key, 'idle');
    }
  });
}
