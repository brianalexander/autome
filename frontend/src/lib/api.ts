import type { WorkflowDefinition, StageDefinition, EdgeDefinition, MCPServerConfig } from '@autome/schemas';
import type {
  WorkflowInstance,
  StageContext,
  StageRun,
  ToolCallRecord,
  SegmentRecord,
  KiroAgentSpec,
  DiscoveredAgent,
  NodeTypeInfo,
} from '@autome/types/instance';

// Re-export all types so existing consumers can still import from api.ts
export type {
  WorkflowDefinition,
  StageDefinition,
  EdgeDefinition,
  MCPServerConfig,
  WorkflowInstance,
  StageContext,
  StageRun,
  ToolCallRecord,
  SegmentRecord,
  KiroAgentSpec,
  DiscoveredAgent,
  NodeTypeInfo,
};

/**
 * Check if a stage type is a trigger. Uses node type specs if available,
 * falls back to convention (type ends with '-trigger' or is exactly 'trigger').
 */
export function isTriggerType(type: string, specs?: NodeTypeInfo[]): boolean {
  if (specs) {
    const spec = specs.find((s) => s.id === type);
    if (spec) return spec.category === 'trigger';
  }
  // Fallback: convention-based (covers 'manual-trigger', 'webhook-trigger', 'cron-trigger', legacy 'trigger')
  return type === 'trigger' || type.endsWith('-trigger');
}

// Bundle import/export types
export interface ImportResult {
  workflowId: string;
  warnings: Array<{ type: string; name: string; message: string }>;
}

export interface HealthWarning {
  type: 'missing_mcp_command' | 'missing_hook_command' | 'missing_secret' | 'missing_agent';
  severity: 'error' | 'warning';
  agentId: string | null;
  message: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  warnings: HealthWarning[];
  checkedAt: string;
}

export interface BundlePreview {
  bundle: {
    name: string;
    description?: string;
    exportedAt: string;
    sourceProvider: string;
    requiredAgents: string[];
  };
  workflow: { name: string; description?: string; stageCount: number; edgeCount: number };
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Workflow definitions
export const workflows = {
  list: (params?: { limit?: number; offset?: number }) => {
    const qs = params
      ? '?' +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : '';
    return request<PaginatedResponse<WorkflowDefinition>>(`/workflows${qs}`);
  },
  get: (id: string) => request<WorkflowDefinition>(`/workflows/${id}`),
  create: (data: Omit<WorkflowDefinition, 'id'>) =>
    request<WorkflowDefinition>('/workflows', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<WorkflowDefinition>) =>
    request<WorkflowDefinition>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  trigger: (id: string, payload?: unknown) =>
    request<WorkflowInstance>(`/workflows/${id}/trigger`, { method: 'POST', body: JSON.stringify({ payload }) }),
  versions: (id: string) =>
    request<Array<{ version: number; created_at: string; name: string; description?: string }>>(
      `/workflows/${id}/versions`,
    ),
  getVersion: (id: string, version: number) => request<WorkflowDefinition>(`/workflows/${id}/versions/${version}`),
  activate: (id: string) => request<{ activated: boolean }>(`/workflows/${id}/activate`, { method: 'POST' }),
  deactivate: (id: string) => request<{ deactivated: boolean }>(`/workflows/${id}/deactivate`, { method: 'POST' }),
  clone: (id: string) => request<WorkflowDefinition>(`/workflows/${id}/clone`, { method: 'POST' }),
  testRun: (workflowId: string, payload?: unknown) =>
    request<{ instance: WorkflowInstance; testWorkflowId: string }>(`/draft/${workflowId}/test-run`, {
      method: 'POST',
      body: JSON.stringify({ payload }),
    }),

  /** Check workflow health — verifies external dependencies are available. */
  health: (id: string) => request<HealthCheckResult>(`/workflows/${id}/health`),

  /** Export workflow as .autome bundle — returns a blob for download. */
  exportBundle: async (id: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/workflows/${id}/export`, { method: 'POST' });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return res.blob();
  },

  /** Import a .autome bundle file. */
  importBundle: async (file: File): Promise<ImportResult> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/workflows/import`, { method: 'POST', body: formData });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return res.json();
  },

  /** Preview a .autome bundle without importing. */
  previewBundle: async (file: File): Promise<BundlePreview> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/workflows/import/preview`, { method: 'POST', body: formData });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return res.json();
  },
};

// Workflow instances
export const instances = {
  list: (filter?: { status?: string; definitionId?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.definitionId) params.set('definitionId', filter.definitionId);
    if (filter?.limit != null) params.set('limit', String(filter.limit));
    if (filter?.offset != null) params.set('offset', String(filter.offset));
    const qs = params.toString();
    return request<PaginatedResponse<WorkflowInstance>>(`/instances${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => request<WorkflowInstance>(`/instances/${id}`),
  getStatus: (id: string) => request<{ status: string; context: WorkflowInstance['context'] } | undefined>(`/instances/${id}/status`),
  cancel: (id: string) => request<{ cancelled: boolean }>(`/instances/${id}/cancel`, { method: 'POST' }),
  delete: (id: string) => request<void>(`/instances/${id}`, { method: 'DELETE' }),
  approveGate: (instanceId: string, stageId: string, data?: unknown) =>
    request<{ approved: boolean }>(`/instances/${instanceId}/gates/${stageId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  rejectGate: (instanceId: string, stageId: string, reason?: string) =>
    request<{ rejected: boolean }>(`/instances/${instanceId}/gates/${stageId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  injectMessage: (instanceId: string, stageId: string, message: string) =>
    request<{ injected: boolean }>(`/instances/${instanceId}/stages/${stageId}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  getSegments: (instanceId: string, stageId: string, iteration?: number) => {
    const params = iteration != null ? `?iteration=${iteration}` : '';
    return request<SegmentRecord[]>(`/instances/${instanceId}/stages/${stageId}/segments${params}`);
  },
  getPrompt: (instanceId: string, stageId: string, iteration?: number) => {
    const params = iteration != null ? `?iteration=${iteration}` : '';
    return request<{ prompt: string; iteration: number; created_at: string }>(
      `/instances/${instanceId}/stages/${stageId}/prompt${params}`,
    );
  },
  cancelStage: (instanceId: string, stageId: string) =>
    request<{ cancelled: boolean }>(`/instances/${instanceId}/stages/${stageId}/cancel`, { method: 'POST' }),
  restartSession: (instanceId: string, stageId: string) =>
    request<{ ok: boolean }>(`/instances/${instanceId}/stages/${stageId}/restart-session`, { method: 'POST' }),
  resume: (id: string, fromStageId?: string) =>
    request<{ instanceId: string; resumeCount: number }>(`/instances/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ fromStageId }),
    }),
  getDefinition: (instanceId: string) => request<WorkflowDefinition>(`/instances/${instanceId}/definition`),
  rename: (id: string, display_summary: string | null) =>
    request<{ instanceId: string; display_summary: string | null }>(`/instances/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_summary }),
    }),
};

// Author chat API
export const authorChat = {
  clearSegments: (workflowId: string) =>
    request<{ ok: boolean }>(`/author/${workflowId}/segments`, { method: 'DELETE' }),
  migrateSegments: (fromId: string, toId: string) =>
    request<{ ok: boolean; migrated: number }>('/internal/author-segments/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromId, toId }),
    }),
  restartSession: (workflowId: string) =>
    request<{ ok: boolean }>(`/author/${workflowId}/restart-session`, { method: 'POST' }),
  clearChat: (workflowId: string) =>
    request<{ ok: boolean }>(`/author/${workflowId}/clear-chat`, { method: 'POST' }),
};

// Session info API
export const sessionInfo = {
  get: (key: string) => request<{ model: string | null; status: string | null }>(`/session-info/${encodeURIComponent(key)}`),
};

// Agent discovery API
export const agents = {
  list: () => request<DiscoveredAgent[]>('/agents'),
  get: (name: string) => request<DiscoveredAgent>(`/agents/${name}`),
};

export const nodeTypes = {
  list: () => request<NodeTypeInfo[]>('/node-types'),
  sampleEvent: (id: string, config?: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/node-types/${encodeURIComponent(id)}/sample-event`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),
};

export interface AcpProvider {
  name: string;
  displayName: string;
  source: 'builtin' | 'plugin';
}

export interface ActiveProvider {
  name: string | null;
  displayName: string | null;
  source: 'settings' | 'env' | 'unconfigured';
}

export const acpProviders = {
  list: async (): Promise<AcpProvider[]> => {
    const res = await fetch('/api/acp-providers');
    if (!res.ok) throw new Error('Failed to fetch providers');
    return res.json();
  },
  active: async (): Promise<ActiveProvider> => {
    const res = await fetch('/api/provider');
    if (!res.ok) throw new Error('Failed to fetch active provider');
    return res.json();
  },
};

export interface PendingApproval {
  instanceId: string;
  workflowName: string;
  workflowId: string;
  stageId: string;
  stageLabel: string;
  gateMessage: string | null;
  upstreamData: unknown;
  waitingSince: string;
}

export const approvals = {
  list: () => request<PendingApproval[]>('/approvals'),
};

export const settings = {
  getAll: () => request<Record<string, string>>('/settings'),
  get: (key: string) => request<{ key: string; value: string }>(`/settings/${key}`),
  set: (key: string, value: string) =>
    request<{ key: string; value: string }>(`/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  delete: (key: string) => request<void>(`/settings/${key}`, { method: 'DELETE' }),
};

export interface PendingAuthorMessage {
  id: number;
  workflow_id: string;
  text: string;
  created_at: string;
}

export const authorApi = {
  flushPendingMessages: (workflowId: string): Promise<{ messages: PendingAuthorMessage[] }> =>
    request(`/author/pending-messages/${encodeURIComponent(workflowId)}/flush`, { method: 'POST' }),
};

// Assistant chat API
// Node templates
export interface NodeTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  node_type: string;
  icon: string | null;
  category: string | null;
  config: Record<string, unknown>;
  exposed: string[];
  locked: string[];
  version: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export const templates = {
  list: (params?: { nodeType?: string; source?: string }) => {
    const qs = params
      ? '?' +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)]),
          ),
        ).toString()
      : '';
    return request<NodeTemplateRecord[]>(`/templates${qs}`);
  },
  get: (id: string) => request<NodeTemplateRecord>(`/templates/${id}`),
  create: (data: {
    name: string;
    description?: string;
    nodeType: string;
    icon?: string;
    category?: string;
    config: Record<string, unknown>;
    exposed?: string[];
    locked?: string[];
  }) => request<NodeTemplateRecord>('/templates', { method: 'POST', body: JSON.stringify(data) }),
  update: (
    id: string,
    data: Partial<{
      name: string;
      description?: string;
      nodeType: string;
      icon?: string;
      category?: string;
      config: Record<string, unknown>;
      exposed?: string[];
      locked?: string[];
    }>,
  ) => request<NodeTemplateRecord>(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/templates/${id}`, { method: 'DELETE' }),
  duplicate: (id: string) => request<NodeTemplateRecord>(`/templates/${id}/duplicate`, { method: 'POST' }),
  import: (items: unknown) =>
    request<NodeTemplateRecord[]>('/templates/import', { method: 'POST', body: JSON.stringify(items) }),
  export: (id: string) => request<Record<string, unknown>>(`/templates/${id}/export`),
};

// Secrets
export interface SecretRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export const secrets = {
  list: () => request<SecretRecord[]>('/secrets'),
  create: (data: { name: string; value: string; description?: string }) =>
    request<SecretRecord>('/secrets', { method: 'POST', body: JSON.stringify(data) }),
  update: (name: string, data: { value: string; description?: string }) =>
    request<SecretRecord>(`/secrets/${name}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (name: string) => request<void>(`/secrets/${name}`, { method: 'DELETE' }),
};

export const assistantApi = {
  sendMessage: (message: string) =>
    request<{ ok: boolean }>('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  stop: () =>
    request<{ ok: boolean }>('/assistant/stop', { method: 'POST' }),
  getSegments: () =>
    request<SegmentRecord[]>('/assistant/segments'),
  deleteSegments: () =>
    request<void>('/assistant/segments', { method: 'DELETE' }),
  restartSession: () =>
    request<{ ok: boolean }>('/assistant/restart-session', { method: 'POST' }),
  clearChat: () =>
    request<{ ok: boolean }>('/assistant/clear-chat', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Trigger observability API (Phase 4)
// ---------------------------------------------------------------------------

export interface TriggerStatus {
  state: 'starting' | 'active' | 'errored' | 'stopped';
  startedAt: string;
  lastEventAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  eventCount: number;
  errorCount: number;
  logsPreview: string[];
}

export const triggersApi = {
  /** Get status + log preview for all active triggers on a workflow. */
  getStatuses: (workflowId: string): Promise<{ triggers: Record<string, TriggerStatus> }> =>
    request(`/workflows/${workflowId}/triggers`),

  /** Get full log buffer for a specific trigger stage. */
  getLogs: (workflowId: string, stageId: string, limit = 200): Promise<{ lines: string[] }> =>
    request(`/workflows/${workflowId}/triggers/${encodeURIComponent(stageId)}/logs?limit=${limit}`),
};
