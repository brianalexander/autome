/**
 * Node Type System — core interfaces for built-in and custom workflow nodes.
 *
 * Every node type (agent, gate, code-executor, cron-trigger, etc.) implements
 * NodeTypeSpec. The registry maps stage.type → spec at runtime.
 */
import type { ExecutionContext } from '../engine/types.js';
import type { WorkflowDefinition, EdgeDefinition } from '../types/workflow.js';
import type { WorkflowContext, NodeTypeInfo } from '../types/instance.js';

// Re-export for downstream consumers
export type { WorkflowDefinition, EdgeDefinition, WorkflowContext, NodeTypeInfo };

/** Output from any stage executor — the workflow doesn't know the specific shape */
export type StageOutput = Record<string, unknown>;

export interface StageInput {
  incomingEdge?: EdgeDefinition;
  sourceOutput?: unknown;
  /** @deprecated Use the target node's config.cycle_behavior instead */
  cycleMode?: 'fresh' | 'continue';
  /** Whether this is a cycle re-entry (the stage has already run in this workflow execution). */
  isCycleReentry?: boolean;
  /** ACP session ID from prior iteration, for 'continue' cycle behavior. */
  priorSessionId?: string;
  /** Merged outputs from multiple upstream stages (fan-in). Key = source stage ID. */
  mergedInputs?: Record<string, unknown>;
  /** For map iterations: the individual element from the mapped array. */
  mapElement?: unknown;
  /** For map iterations: index within the array. */
  mapIndex?: number;
}

// ---------------------------------------------------------------------------
// Node colors for canvas rendering
// ---------------------------------------------------------------------------

export interface NodeColor {
  /** Background color (hex). Used on canvas nodes and toolbar. */
  bg: string;
  /** Border color (hex). Used on canvas nodes. */
  border: string;
  /** Text/accent color (hex). Used for labels and icons. */
  text: string;
}

// ---------------------------------------------------------------------------
// Step Executor — for nodes that execute within a workflow run
// ---------------------------------------------------------------------------

export interface StepExecutorContext {
  /** Execution context for durable operations (ctx.waitFor, ctx.sleep) */
  ctx: ExecutionContext;
  /** Stage ID within the workflow */
  stageId: string;
  /** Node-specific config from the stage definition */
  config: Record<string, unknown>;
  /** Full workflow definition */
  definition: WorkflowDefinition;
  /** Runtime workflow context (trigger payload, stage statuses, outputs) */
  workflowContext: WorkflowContext;
  /** Input from the upstream stage/edge */
  input?: StageInput;
  /** Base URL of the orchestrator API server */
  orchestratorUrl: string;
  /** Current iteration (for cycled stages) */
  iteration: number;
  /** Decrypted secrets map, injected by the executor at runtime */
  secrets?: Record<string, string>;
}

export interface StepExecutor {
  type: 'step';
  /**
   * Execute the node's logic. Returns the node's output, which flows to downstream edges.
   */
  execute(execCtx: StepExecutorContext): Promise<{ output: unknown; logs?: string; stderr?: string }>;
}

// ---------------------------------------------------------------------------
// Trigger Executor — for nodes that start workflows
// ---------------------------------------------------------------------------

/**
 * Logger injected into trigger executors for structured, observable logging.
 * Messages are stored in a bounded ring buffer and exposed via the API.
 */
export interface TriggerLogger {
  info(msg: string): void;
  warn(msg: string): void;
  /** Also records the error in trigger status (bumps errorCount, sets lastError). */
  error(msg: string, err?: Error): void;
}

/**
 * Context object passed to TriggerExecutor.activate().
 * Replaces the old positional parameter signature.
 */
export interface TriggerActivateContext {
  workflowId: string;
  stageId: string;
  config: Record<string, unknown>;
  emit: (payload: Record<string, unknown>) => void;
  secrets?: Record<string, string>;
  logger: TriggerLogger;
}

export interface TriggerExecutor {
  type: 'trigger';
  /**
   * Called when the workflow is activated. Sets up a listener (cron job, WebSocket,
   * polling loop, etc.) that calls emit() when events occur.
   * Returns a cleanup function to tear down the listener.
   *
   * Receives a TriggerActivateContext with workflowId, stageId, config, emit,
   * secrets, and a structured logger.
   */
  activate?(ctx: TriggerActivateContext): Promise<() => void> | (() => void);
  /**
   * Optional: return a representative event payload for test runs.
   * The user's test invocation will be seeded with this shape instead of
   * the generic `{source:'cron',scheduled_at}` default. If absent, the
   * frontend falls back to a generic JSON dialog driven by output_schema.
   */
  sampleEvent?: (config: Record<string, unknown>) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ConfigCard — declarative page-level affordances rendered above SchemaForm
// ---------------------------------------------------------------------------

export type ConfigCard =
  | { kind: 'help-text'; title?: string; markdown: string }
  | { kind: 'copy-url'; title: string; urlTemplate: string; description?: string }
  | { kind: 'curl-snippet'; title: string; template: string; description?: string }
  | { kind: 'preview-template'; title: string; field: string; description?: string }
  | { kind: 'activation-status'; title?: string }
  /** Renders the cycle-behavior select only when this stage is actually in a cycle edge. */
  | { kind: 'cycle-behavior'; title?: string };

// Re-export so downstream consumers (frontend) can import from this module
export type { ConfigCard as ConfigCardType };

// ---------------------------------------------------------------------------
// Node Type Spec — the complete definition of a node type
// ---------------------------------------------------------------------------

export interface NodeTypeSpec {
  /** Unique type ID, matches stage.type in workflow definitions. e.g. 'agent', 'code-executor' */
  id: string;
  /** Human-readable name shown in the UI. e.g. "HTTP Request" */
  name: string;
  /** Whether this is a trigger (entry point) or step (executed within a workflow) */
  category: 'trigger' | 'step';
  /** Short description of what this node does */
  description: string;
  /** Lucide icon name for the canvas (e.g. 'terminal', 'bot', 'globe') */
  icon: string;
  /** Color theme for canvas rendering */
  color: NodeColor;
  /** JSON Schema describing the node's configuration — drives auto-generated forms */
  configSchema: Record<string, unknown>;
  /** Default config values when a new node of this type is created */
  defaultConfig: Record<string, unknown>;
  /** The executor that runs this node's logic */
  executor: StepExecutor | TriggerExecutor;

  /**
   * JSON Schema for additional fields on incoming edges targeting this node.
   * The edge config panel renders these as form fields when this node is the target.
   * Example: an agent node declares it accepts prompt_template.
   */
  inEdgeSchema?: Record<string, unknown>;

  /**
   * JSON Schema for additional fields on outgoing edges from this node.
   * The edge config panel renders these as form fields when this node is the source.
   */
  outEdgeSchema?: Record<string, unknown>;

  /**
   * For trigger nodes only. Controls how the "Test Run" / "Run" buttons behave:
   *   - 'prompt': Show an input dialog for the user to enter a payload (default for triggers)
   *   - 'immediate': Launch immediately with a generated default payload (e.g. cron)
   */
  triggerMode?: 'prompt' | 'immediate';

  /**
   * Declarative page-level affordances rendered above SchemaForm in StageConfigForm.
   * Cards are rendered in declaration order.
   *
   * Template substitution in urlTemplate / curl-snippet.template:
   *   {workflowId}  → current workflow ID
   *   {stageId}     → current stage ID
   *   {apiOrigin}   → window.location.origin
   *   {config.FIELD} → value of config[FIELD] (e.g. {config.secret})
   */
  configCards?: ConfigCard[];
}

// NodeTypeInfo is now defined as a Zod schema in src/types/instance.ts
// and re-exported above for downstream consumers.
