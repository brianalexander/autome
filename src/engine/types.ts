/**
 * ExecutionContext — the in-process execution primitive for workflow stages.
 *
 * Provided by the WorkflowRunner to every stage executor. State mutations are
 * synced to the DB synchronously. Durable waits (gates, agent callbacks) use
 * the gates table for persistence across restarts.
 */
export interface ExecutionContext {
  /** Workflow instance ID (stable across restarts, unique per instance). */
  readonly instanceId: string;

  /**
   * Base URL for self-calls back to the orchestrator API (e.g. spawn-agent,
   * kill-agent). Sourced from the resolved runtime port — never from the static
   * config.orchestratorUrl which is computed at module load before the port is
   * known.
   */
  readonly orchestratorUrl: string;

  /** Updates instance status in DB and in-memory state. */
  setStatus(status: string): void;

  /** Updates the full workflow context (stages, fan-in state, etc.) in DB. */
  setContext(context: import('../types/instance.js').WorkflowContext): void;

  /** Updates the currently-executing stage IDs. */
  setCurrentStageIds(ids: string[]): void;

  /**
   * Wait for a durable signal. Key patterns:
   *   - `gate-<stageId>` for manual gate approvals
   *   - `stage-complete-<stageId>` for agent callback completion
   *
   * Creates a waiting row in `gates` table if one doesn't exist, then awaits
   * the in-memory resolver. On resolve, returns the payload. On reject, throws.
   */
  waitFor<T = unknown>(key: string): Promise<T>;

  /** Simple setTimeout-backed sleep. Not durable. Use for retry backoffs only. */
  sleep(ms: number): Promise<void>;

  /**
   * AbortSignal fired when the instance is cancelled.
   * Executors should check signal.aborted periodically and honor it.
   */
  readonly abortSignal: AbortSignal;
}

/** Error type that, when thrown from a stage, prevents retry. */
export class TerminalError extends Error {
  readonly terminal = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

export function isTerminalError(err: unknown): err is TerminalError {
  return err instanceof TerminalError || (err instanceof Error && (err as Error & { terminal?: boolean }).terminal === true);
}

// ---------------------------------------------------------------------------
// EngineStepExecutorContext — the new step executor context used by src/engine/
// Stage B will migrate node types to use this instead of StepExecutorContext.
// ---------------------------------------------------------------------------

export interface EngineStepExecutorContext {
  /** New-engine execution context */
  ctx: ExecutionContext;
  /** Stage ID within the workflow */
  stageId: string;
  /** Node-specific config from the stage definition */
  config: Record<string, unknown>;
  /** Full workflow definition */
  definition: import('../types/workflow.js').WorkflowDefinition;
  /** Runtime workflow context (trigger payload, stage statuses, outputs) */
  workflowContext: import('../types/instance.js').WorkflowContext;
  /** Input from the upstream stage/edge */
  input?: import('../nodes/types.js').StageInput;
  /** Base URL of the orchestrator API server */
  orchestratorUrl: string;
  /** Current iteration (for cycled stages) */
  iteration: number;
}

export interface EngineStepExecutor {
  type: 'step';
  execute(execCtx: EngineStepExecutorContext): Promise<{ output: unknown; logs?: string; stderr?: string }>;
}
