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
  importedAgents: string[];
  extractedResources: string[];
  warnings: Array<{ type: string; message: string }>;
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
  manifest: {
    formatVersion: number;
    name: string;
    description?: string;
    exportedAt: string;
    agents: Record<string, { spec: string; resources: string[] }>;
    requirements: { mcpServers: string[]; systemDependencies: string[]; secrets: string[] };
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
  approveGate: (instanceId: string, stageId: string) =>
    request<{ approved: boolean }>(`/instances/${instanceId}/gates/${stageId}/approve`, { method: 'POST' }),
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
  getDefinition: (instanceId: string) => request<WorkflowDefinition>(`/instances/${instanceId}/definition`),
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
