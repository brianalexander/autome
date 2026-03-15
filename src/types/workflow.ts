/**
 * Workflow types — plain TypeScript interfaces for node-config-level types,
 * plus re-exports of structural/workflow-level types from Zod schemas.
 *
 * Node-config types are defined here as interfaces (JSON Schema is the runtime
 * source of truth; Zod is derived at runtime from the node registry).
 * Structural types (StageDefinition, WorkflowDefinition, etc.) are still
 * inferred from their Zod schemas in schemas/pipeline.ts.
 */

// ---------------------------------------------------------------------------
// Node-config-level types (defined as plain interfaces — no Zod schema)
// ---------------------------------------------------------------------------

/** MCP server configuration for agent overrides */
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Agent overrides — can customize model, prompt, tools, MCP servers */
export interface AgentOverrides {
  model?: string;
  additional_prompt?: string;
  additional_tools?: string[];
  additional_mcp_servers?: MCPServerConfig[];
  acpProvider?: string;
}

/** Agent stage configuration */
export interface AgentConfig {
  agentId: string;
  max_iterations?: number | null;
  max_turns?: number | null;
  timeout_minutes?: number | null;
  cycle_behavior?: 'fresh' | 'continue';
  output_schema?: Record<string, unknown>;
  overrides?: AgentOverrides | null;
}

/** Gate stage configuration */
export interface GateConfig {
  type: 'manual' | 'conditional' | 'auto';
  condition?: string;
  message?: string;
  timeout_minutes?: number;
  timeout_action?: 'approve' | 'reject';
}

/** Trigger configuration */
export interface TriggerConfig {
  provider: 'manual' | 'webhook';
  filter?: Record<string, unknown>;
  webhook?: {
    secret?: string;
    payload_filter?: string;
  };
}

// ---------------------------------------------------------------------------
// Structural/workflow-level types (inferred from Zod schemas)
// ---------------------------------------------------------------------------

export type {
  WatcherDefinition,
  StageDefinition,
  EdgeDefinition,
  WorkflowDefinition,
} from '../schemas/pipeline.js';

export type {
  ACPMessage,
  StageRun,
  StageContext,
  WorkflowContext,
  WorkflowInstance,
  ToolCallRecord,
  SegmentRecord,
  KiroAgentSpec,
  DiscoveredAgent,
  NodeTypeInfo,
} from './instance.js';

export type JSONSchema = Record<string, unknown>;
