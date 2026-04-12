import { z } from 'zod';
import type { Event } from './events.js';

// ---------------------------------------------------------------------------
// ACPMessage
// ---------------------------------------------------------------------------

export const ACPMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ACPMessage = z.infer<typeof ACPMessageSchema>;

// ---------------------------------------------------------------------------
// StageRun
// ---------------------------------------------------------------------------

export const StageRunSchema = z.object({
  iteration: z.number(),
  started_at: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['running', 'completed', 'failed']),
  completed_at: z.string().optional(),
  output: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  error: z.string().optional(),
  transcript: z.array(ACPMessageSchema).optional(),
  logs: z.string().optional(),    // console output from code/shell execution
  stderr: z.string().optional(),  // stderr output
});

export type StageRun = z.infer<typeof StageRunSchema>;

// ---------------------------------------------------------------------------
// StageContext
// ---------------------------------------------------------------------------

export const StageContextSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  run_count: z.number(),
  runs: z.array(StageRunSchema),
  latest: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  acp_session_id: z.string().optional(),
});

export type StageContext = z.infer<typeof StageContextSchema>;

// ---------------------------------------------------------------------------
// WorkflowContext (consolidated — was duplicated in nodes/types.ts and restate/pipeline-workflow.ts)
// Note: restate/pipeline-workflow.ts is the Restate service file (filename intentional)
// ---------------------------------------------------------------------------

export const WorkflowContextSchema = z.object({
  trigger: z.record(z.string(), z.unknown()),
  stages: z.record(z.string(), StageContextSchema),
  edgeTraversals: z.record(z.string(), z.number()).optional(),
  /** Fan-in tracking: { [targetStageId]: { [sourceStageId]: output } } — accumulates as upstream stages complete */
  fanInCompletions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Queue-mode pending inputs: { [stageId]: [{ incomingEdge, sourceOutput }, ...] } */
  pendingInputs: z.record(z.string(), z.array(z.object({
    incomingEdge: z.record(z.string(), z.unknown()).optional(),
    sourceOutput: z.unknown().optional(),
  }))).optional(),
});

export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

// ---------------------------------------------------------------------------
// InitiatedBy — who started a workflow instance
// ---------------------------------------------------------------------------

export type InitiatedBy = 'user' | 'author' | 'webhook' | 'cron';

// ---------------------------------------------------------------------------
// PendingAuthorMessage — buffered system messages for the author chat
// ---------------------------------------------------------------------------

export interface PendingAuthorMessage {
  id: number;
  workflow_id: string;
  text: string;
  kind: 'system' | 'user';
  created_at: string;
}

// ---------------------------------------------------------------------------
// WorkflowInstance
// ---------------------------------------------------------------------------

export const WorkflowInstanceSchema = z.object({
  id: z.string(),
  definition_id: z.string().nullable(),
  definition_version: z.number().int().positive().optional().nullable(),
  status: z.enum(['running', 'waiting_gate', 'waiting_input', 'completed', 'failed', 'cancelled']),
  trigger_event: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().optional(),
  restate_workflow_id: z.string().optional(),
  is_test: z.boolean().optional(),
  /** Who initiated this workflow run */
  initiated_by: z.enum(['user', 'author', 'webhook', 'cron']).default('user'),
  /** Number of times this instance was resumed */
  resume_count: z.number().int().default(0),
  context: WorkflowContextSchema,
  current_stage_ids: z.array(z.string()),
});

export type WorkflowInstance = z.infer<typeof WorkflowInstanceSchema>;

// ---------------------------------------------------------------------------
// ToolCallRecord
// ---------------------------------------------------------------------------

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  raw_input: z.string().nullable(),
  raw_output: z.string().nullable(),
  parent_tool_use_id: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

// ---------------------------------------------------------------------------
// SegmentRecord
// ---------------------------------------------------------------------------

export const SegmentRecordSchema = z.object({
  id: z.number(),
  segment_index: z.number(),
  segment_type: z.enum(['text', 'tool', 'user']),
  content: z.string().nullable(),
  tool_call: ToolCallRecordSchema.nullable(),
  created_at: z.string(),
});

export type SegmentRecord = z.infer<typeof SegmentRecordSchema>;

// ---------------------------------------------------------------------------
// KiroAgentSpec
// ---------------------------------------------------------------------------

export const KiroAgentSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  mcpServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        autoApprove: z.array(z.string()).optional(),
        disabledTools: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  resources: z.array(z.string()).optional(),
  hooks: z.record(z.string(), z.any()).optional(),
  keyboardShortcut: z.string().optional(),
  welcomeMessage: z.string().optional(),
  includeMcpJson: z.boolean().optional(),
  toolAliases: z.record(z.string(), z.string()).optional(),
  toolsSettings: z.record(z.string(), z.any()).optional(),
});

export type KiroAgentSpec = z.infer<typeof KiroAgentSpecSchema>;

// ---------------------------------------------------------------------------
// CanonicalAgentSpec — provider-neutral spec; all providers normalize to this
// ---------------------------------------------------------------------------

export const CanonicalAgentSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.record(z.string(), z.object({
    command: z.string(),
    args: z.array(z.string()),
    env_keys: z.array(z.string()).optional(),
  })).optional(),
  // Allow extra provider-specific fields to pass through
  prompt: z.string().optional(),
}).passthrough();

export type CanonicalAgentSpec = z.infer<typeof CanonicalAgentSpecSchema>;

// AgentSpec is the canonical type; KiroAgentSpec is kept as a Kiro-specific extension
export const AgentSpecSchema = CanonicalAgentSpecSchema;
export type AgentSpec = CanonicalAgentSpec;

// ---------------------------------------------------------------------------
// DiscoveredAgent
// ---------------------------------------------------------------------------

export const DiscoveredAgentSchema = z.object({
  name: z.string(),
  spec: AgentSpecSchema,
  source: z.enum(['local', 'global']),
  path: z.string(),
});

export type DiscoveredAgent = z.infer<typeof DiscoveredAgentSchema>;

// ---------------------------------------------------------------------------
// NodeTypeInfo (frontend-safe subset of NodeTypeSpec)
// ---------------------------------------------------------------------------

export const NodeTypeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(['trigger', 'step']),
  description: z.string(),
  icon: z.string(),
  color: z.object({
    bg: z.string(),
    border: z.string(),
    text: z.string(),
  }),
  configSchema: z.record(z.string(), z.unknown()),
  defaultConfig: z.record(z.string(), z.unknown()),
  executorType: z.enum(['step', 'trigger']),
  inEdgeSchema: z.record(z.string(), z.unknown()).optional(),
  outEdgeSchema: z.record(z.string(), z.unknown()).optional(),
  triggerMode: z.enum(['prompt', 'immediate']).optional(),
});

export type NodeTypeInfo = z.infer<typeof NodeTypeInfoSchema>;
