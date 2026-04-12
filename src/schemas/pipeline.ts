/**
 * Workflow schemas — structural/workflow-level Zod schemas.
 *
 * Per-node-type config schemas (AgentConfig, GateConfig, TriggerConfig, etc.)
 * have been removed — JSON Schema is the source of truth for those, and Zod
 * is derived at runtime from the node registry. TypeScript types for those
 * are plain interfaces in src/types/workflow.ts.
 *
 * Uses Zod v4's native .meta() for descriptions (no extendZodWithOpenApi needed).
 * Schemas are registered with the OpenAPI registry in openapi.ts.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Must be called before any schema definitions so .openapi() is available on all types
extendZodWithOpenApi(z);

// ---------------------------------------------------------------------------
// Primitives / shared
// ---------------------------------------------------------------------------

export const PositionSchema = z.object({
  x: z.number().meta({ description: 'X coordinate on the canvas' }),
  y: z.number().meta({ description: 'Y coordinate on the canvas' }),
});

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export const WatcherDefinitionSchema = z.object({
  id: z.string().meta({ description: 'Unique watcher identifier' }),
  provider: z.string().meta({ description: 'Watcher provider (e.g. "github", "slack")' }),
  event: z.string().meta({ description: 'Event to watch for' }),
  filter: z.record(z.string(), z.unknown()).optional().meta({ description: 'Optional event filter' }),
  injection_template: z
    .string()
    .optional()
    .meta({ description: 'Template for injecting watcher data into stage context' }),
});

// ---------------------------------------------------------------------------
// Retry config (for step stages)
// ---------------------------------------------------------------------------

export const RetryConfigSchema = z.object({
  max_attempts: z
    .number()
    .int()
    .min(1)
    .max(10)
    .meta({ description: 'Maximum number of execution attempts (default: 1 = no retry)' }),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .meta({ description: 'Initial delay between retries in milliseconds (default: 1000)' }),
  backoff_multiplier: z.number().min(1).optional().meta({
    description: 'Multiplier applied to delay after each retry (default: 2). E.g., 1000ms → 2000ms → 4000ms.',
  }),
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export const StageDefinitionSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      'Stage ID must be snake_case: lowercase letters, digits, and underscores, starting with a letter',
    )
    .meta({ description: 'Unique stage identifier. Used in edges to reference this stage.' }),
  type: z.string().meta({
    description:
      'Node type ID from the node registry. Built-in types: "agent", "gate", "manual-trigger", "webhook-trigger", "cron-trigger", "code-executor". Custom types are discovered from src/nodes/custom/.',
  }),
  label: z.string().optional().meta({ description: 'Human-readable label shown on the canvas node' }),
  readme: z
    .string()
    .optional()
    .meta({
      description:
        'CommonMark markdown README for this stage. Supports headings, lists, code blocks, links, and emphasis. This is for context that ISN\'T already obvious from the stage config — e.g. caveats, callouts, requirements, gotchas, why a particular choice was made, links to relevant docs. Don\'t restate inputs/outputs (those are visible from the config and edges). Shown in the config panel and instance sidebar.',
    }),
  position: PositionSchema.optional().meta({ description: 'Canvas position for rendering' }),
  /** Node-specific configuration — contents depend on the node type */
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .meta({ description: 'Node-specific configuration. Schema depends on the node type.' }),
  watchers: z.array(WatcherDefinitionSchema).optional().meta({ description: 'Event watchers attached to this stage' }),

  // --- Input mode ---
  input_mode: z.enum(['queue', 'fan_in']).optional().meta({
    description:
      'How the stage handles multiple incoming edges. "queue" (default): each edge independently triggers execution, processed FIFO. "fan_in": waits for multiple upstream completions per trigger_rule before executing.',
  }),

  // --- Fan-in / join behavior ---
  trigger_rule: z.enum(['all_success', 'any_success', 'none_failed_min_one_success']).optional().meta({
    description:
      'How this stage joins multiple upstream completions. Only applies when input_mode is "fan_in". "all_success" (default) = wait for every upstream to succeed. "any_success" = fire as soon as any one upstream succeeds. "none_failed_min_one_success" = fire if at least one upstream succeeded and none failed (skipped branches are OK).',
  }),

  // --- Retry ---
  retry: RetryConfigSchema.optional().meta({
    description: 'Retry configuration for this stage. If omitted, the stage is not retried on failure.',
  }),

  // --- Dynamic map (fan-out over array) ---
  map_over: z.string().optional().meta({
    description:
      'Template expression resolving to an array (e.g. "{{ stages.splitter.output.items }}"). When set, the stage executes once per array element. Each execution receives the element as input. Results are collected into an output array.',
  }),
  concurrency: z.number().int().min(1).optional().meta({
    description: 'Maximum number of parallel map executions (only applies when map_over is set). Default: unlimited.',
  }),
  failure_tolerance: z.number().int().min(0).optional().meta({
    description:
      'Number of allowed map iteration failures before the entire stage fails (only applies when map_over is set). Default: 0 (any failure = stage failure).',
  }),
});

// ---------------------------------------------------------------------------
// Edge — flat schema, node types declare their own edge features via inEdgeSchema/outEdgeSchema
// ---------------------------------------------------------------------------

export const EdgeDefinitionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'Edge ID must be snake_case')
    .meta({ description: 'Unique edge identifier' }),
  source: z.string().meta({ description: 'Source stage ID — where data flows from' }),
  target: z.string().meta({ description: 'Target stage ID — where data flows to' }),
  label: z.string().optional().meta({ description: 'Human-readable label shown on the edge in the canvas' }),
  condition: z.string().optional().meta({
    description:
      'JavaScript expression evaluated to determine if this edge should be followed. If omitted, the edge is always followed.',
  }),
  trigger: z.enum(['on_success', 'on_error']).optional().meta({
    description:
      'When this edge fires. "on_success" (default) = fires when the source succeeds. "on_error" = fires only when the source fails after exhausting retries. Error edges receive { error, stageId, lastOutput } as input.',
  }),
  prompt_template: z.string().optional().meta({
    description:
      'Jinja2 prompt template injected into the target stage. Use {{ output.<field> }} for source output. Supports conditionals ({% if %}), loops ({% for %}), and filters ({{ value | upper }}).',
  }),
  max_traversals: z.number().int().positive().optional().meta({
    description: 'Maximum number of times this edge can be traversed per workflow run.',
  }),
});

// ---------------------------------------------------------------------------
// Workflow (top-level)
// ---------------------------------------------------------------------------

export const WorkflowTopLevelTriggerSchema = z.object({
  provider: z.string().meta({ description: 'Trigger provider name' }),
  filter: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string().meta({ description: 'Workflow UUID' }),
  name: z.string().meta({ description: 'Workflow name' }),
  description: z.string().optional().meta({
    description:
      'CommonMark markdown README for the workflow. Supports headings, lists, code blocks, links, and emphasis. Use this for high-level context: what the workflow is for, caveats, callouts, requirements, authorship, credits, links to relevant docs. Don\'t restate the graph structure (visible on the canvas) or trigger schema (visible on the trigger node). Shown in the canvas info bubble as a truncated preview; full markdown opens in a modal editor.',
  }),
  active: z.boolean().meta({ description: 'Whether the workflow is active and can be triggered' }),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .meta({ description: 'Definition version, auto-incremented on each update' }),
  trigger: WorkflowTopLevelTriggerSchema.meta({
    description: 'Top-level trigger config (also represented as a trigger stage)',
  }),
  stages: z.array(StageDefinitionSchema).meta({ description: 'All stages in the workflow' }),
  edges: z.array(EdgeDefinitionSchema).meta({ description: 'All edges connecting stages' }),
  /** Default ACP provider for this workflow's agent stages. Overrides the system default. */
  acpProvider: z.string().optional().meta({
    description:
      'Default ACP provider for this workflow\'s agent stages (e.g. "kiro", "opencode"). Overrides the system-wide ACP_PROVIDER env var.',
  }),
  /** Parent workflow ID — set on test workflows to link them to the originating workflow */
  parent_workflow_id: z.string().optional().meta({
    description: 'Parent workflow ID. Set on test workflows to link them to the originating workflow.',
  }),
  /** AI Author settings for this workflow */
  authoring: z.object({
    auto_test: z.boolean().optional().meta({
      description:
        'When true, the AI Author automatically runs tests after meaningful edits and iterates on failures. When false (default), it proposes a test and waits for confirmation.',
    }),
  }).optional().meta({
    description: 'AI Author settings for this workflow',
  }),
});

// ---------------------------------------------------------------------------
// WorkflowAuthoring type export
// ---------------------------------------------------------------------------

export type WorkflowAuthoring = {
  auto_test?: boolean;
};

// ---------------------------------------------------------------------------
// Request body schemas for the draft sub-resource API
// ---------------------------------------------------------------------------

export const CreateStageBodySchema = StageDefinitionSchema.omit({ position: true })
  .extend({
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]*$/,
        'Stage ID must be snake_case: lowercase letters, digits, and underscores, starting with a letter',
      )
      .optional()
      .meta({ description: 'Stage ID. Auto-generated if not provided.' }),
    position: PositionSchema.optional(),
  })
  .strict();

export const UpdateStageBodySchema = z
  .object({
    type: z.string().optional(),
    label: z.string().optional().nullable().meta({ description: 'Short display label shown on the canvas node' }),
    readme: z.string().optional().nullable().meta({
      description:
        'CommonMark markdown README for this stage. Use this for context that isn\'t already obvious from the stage config — caveats, callouts, requirements, gotchas, why a particular choice was made, links to relevant docs. Don\'t restate inputs/outputs.',
    }),
    position: PositionSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

// Create edge body — available fields depend on source/target node types
export const CreateEdgeBodySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'Edge ID must be snake_case')
      .optional()
      .meta({ description: 'Edge ID. Auto-generated if not provided.' }),
    source: z.string().meta({ description: 'Source stage ID' }),
    target: z.string().meta({ description: 'Target stage ID' }),
    label: z.string().optional().meta({ description: 'Human-readable label' }),
    condition: z.string().optional().meta({ description: 'JS condition expression' }),
    trigger: z
      .enum(['on_success', 'on_error'])
      .optional()
      .meta({ description: 'When this edge fires — "on_success" (default) or "on_error" (fallback path).' }),
    prompt_template: z.string().optional().meta({
      description:
        'Jinja2 prompt template. Use {{ output.<field> }} to reference the source stage output. Supports {% if %}, {% for %}, and filters. Required for edges into agent nodes.',
    }),
    max_traversals: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: 'Max times this edge can be traversed per workflow run.' }),
  })
  .strict()
  .meta({
    description:
      'Create an edge between two stages. Available fields (prompt_template, max_traversals, etc.) depend on the source and target node types.',
  });

// Update edge body — partial updates
export const UpdateEdgeBodySchema = z
  .object({
    label: z.string().optional().nullable(),
    condition: z.string().optional().nullable(),
    trigger: z.enum(['on_success', 'on_error']).optional().nullable(),
    prompt_template: z.string().optional().nullable(),
    max_traversals: z.number().int().positive().optional().nullable(),
  })
  .strict();

export const UpdateTriggerBodySchema = z.object({
  provider: z.enum(['manual', 'webhook']).meta({
    description:
      'Trigger provider type. "manual" = triggered via UI button or API call. "webhook" = triggered by an incoming HTTP POST to the webhook endpoint.',
  }),
  filter: z.record(z.string(), z.unknown()).optional().meta({ description: 'Optional event filter criteria' }),
  webhook: z
    .object({
      secret: z
        .string()
        .optional()
        .meta({ description: 'Optional secret for HMAC signature validation of incoming webhook payloads' }),
      payload_filter: z
        .string()
        .optional()
        .meta({ description: 'Optional JavaScript expression to filter/transform incoming webhook payloads' }),
    })
    .optional()
    .meta({ description: 'Webhook-specific configuration (only for provider="webhook")' }),
});

export const UpdateMetadataBodySchema = z
  .object({
    name: z.string().optional().meta({ description: 'Workflow name' }),
    description: z.string().optional().meta({
      description:
        'CommonMark markdown README for the workflow. Use this for high-level context: what the workflow is for, caveats, callouts, requirements, authorship, credits, links to relevant docs. Don\'t restate the graph structure or trigger schema.',
    }),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type Position = z.infer<typeof PositionSchema>;
export type WatcherDefinition = z.infer<typeof WatcherDefinitionSchema>;
export type WorkflowTopLevelTrigger = z.infer<typeof WorkflowTopLevelTriggerSchema>;
export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type StageDefinition = z.infer<typeof StageDefinitionSchema>;
export type EdgeDefinition = z.infer<typeof EdgeDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// Node-config-level types are defined as plain interfaces in types/workflow.ts.
// Re-export them here for consumers that import from schemas/pipeline.ts directly.
export type { MCPServerConfig, AgentOverrides, AgentConfig, GateConfig, TriggerConfig } from '../types/workflow.js';
