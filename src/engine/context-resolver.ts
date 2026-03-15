import type { WorkflowContext } from '../restate/pipeline-workflow.js';
import type { StageDefinition, EdgeDefinition, WorkflowDefinition } from '../types/workflow.js';

// Helper to access edge fields that may not be present on all edge variants
function getEdgePromptTemplate(edge: EdgeDefinition): string | undefined {
  return edge.prompt_template;
}

/**
 * Safe property-path resolver. No eval, no new Function, no with().
 *
 * Supported syntax:
 *   output.plan                              → scope.output.plan
 *   stages.planner.output.plan               → scope.stages.planner.output.plan
 *   stages['plan-reviewer'].output.feedback  → scope.stages['plan-reviewer'].output.feedback
 *   trigger.prompt                           → scope.trigger.prompt
 */
function resolvePath(expression: string, scope: Record<string, unknown>): unknown {
  const tokens: string[] = [];
  // Match: .identifier, ['string'], ["string"], or bare leading identifier
  const re = /(?:^|\.)(\w+)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(expression)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  if (tokens.length === 0) return undefined;

  let current: unknown = scope;
  for (const token of tokens) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * Builds the scope object that template expressions resolve against.
 *
 * Available paths:
 *   output.<field>                  — source stage's output (through this edge)
 *   stages.<id>.output.<field>      — any upstream stage's latest output
 *   stages['id'].output.<field>     — bracket notation for hyphenated IDs
 *   trigger.<field>                 — trigger event payload
 *   sourceOutputs.<stageId>.<field> — fan-in: each upstream stage's output by ID
 */
function buildScope(
  sourceOutput: unknown,
  context: WorkflowContext,
  mergedInputs?: Record<string, unknown>,
): Record<string, unknown> {
  const stagesScope: Record<string, { output: unknown; runs: unknown[] }> = {};
  for (const [stageId, stageCtx] of Object.entries(context.stages)) {
    stagesScope[stageId] = {
      output: stageCtx.latest,
      runs: stageCtx.runs || [],
    };
  }
  const scope: Record<string, unknown> = {
    output: sourceOutput,
    stages: stagesScope,
    trigger: context.trigger,
  };
  if (mergedInputs) {
    scope['sourceOutputs'] = mergedInputs;
  }
  return scope;
}

/**
 * Formats a value for insertion into a template:
 * - null/undefined → empty string
 * - string → as-is
 * - object/array → JSON.stringify with 2-space indent
 * - other primitives → String()
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Processes `{% if expression %}...{% endif %}` blocks in the template.
 * Single-level only (no nesting). The body is included only when the
 * expression evaluates to a truthy value.
 */
function processConditionals(template: string, scope: Record<string, unknown>): string {
  const ifPattern = /\{%\s*if\s+(.+?)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g;
  return template.replace(ifPattern, (_match, expression: string, body: string) => {
    const value = resolvePath(expression.trim(), scope);
    return value ? body : '';
  });
}

/**
 * Processes `{{ expression }}` interpolations in the template.
 */
function processInterpolations(template: string, scope: Record<string, unknown>): string {
  const exprPattern = /\{\{\s*(.+?)\s*\}\}/g;
  return template.replace(exprPattern, (_match, expression: string) => {
    const value = resolvePath(expression.trim(), scope);
    return formatValue(value);
  });
}

/**
 * Resolves an edge prompt template against the workflow context.
 *
 * Template variables:
 *   {{ output.field }}                         — source stage's output
 *   {{ stages.planner.output.plan }}           — any stage's output by ID
 *   {{ stages['plan-reviewer'].output.feedback }} — bracket notation for hyphens
 *   {{ trigger.prompt }}                       — trigger payload
 *   {{ sourceOutputs.stageId.field }}          — fan-in: a specific upstream stage's output
 *   {% if output.approved %}...{% endif %}     — conditionals
 */
function resolveEdgeTemplate(
  template: string,
  sourceOutput: unknown,
  context: WorkflowContext,
  mergedInputs?: Record<string, unknown>,
): string {
  const scope = buildScope(sourceOutput, context, mergedInputs);
  let result = processConditionals(template, scope);
  result = processInterpolations(result, scope);
  return result;
}

/**
 * Collect output requirements from all outgoing edges of a stage.
 * Scans prompt_templates for {{ output.field }} references to auto-inject
 * "your output MUST include these fields" into agent prompts.
 */
function collectOutputRequirements(stageId: string, definition: WorkflowDefinition): string {
  const outgoing = definition.edges.filter((e) => e.source === stageId);
  const allFields = new Map<string, { type?: string; description?: string }>();

  // Scan edge prompt_templates for {{ output.field }} references
  for (const edge of outgoing) {
    const pt = getEdgePromptTemplate(edge);
    if (pt) {
      // Match {{ output.field }} pattern
      const outputMatches = pt.matchAll(/\{\{\s*output\.(\w+)\s*\}\}/g);
      for (const m of outputMatches) {
        if (!allFields.has(m[1])) {
          allFields.set(m[1], {});
        }
      }
      // Also match {{ stages.THIS_STAGE.output.field }} referencing this stage from downstream
      const stagesPattern = new RegExp(
        `\\{\\{\\s*stages(?:\\['${stageId}'\\]|\\.${stageId.replace(/[^a-zA-Z0-9]/g, '\\$&')})\\.output\\.(\\w+)\\s*\\}\\}`,
        'g',
      );
      const stagesMatches = pt.matchAll(stagesPattern);
      for (const m of stagesMatches) {
        if (!allFields.has(m[1])) {
          allFields.set(m[1], {});
        }
      }
    }
  }

  if (allFields.size === 0) return '';

  const lines = ['', 'IMPORTANT: Your output (via workflow_signal with status "completed") MUST include these fields:'];
  for (const [name, info] of allFields) {
    let line = `  - ${name}`;
    if (info.type) line += ` (${info.type})`;
    if (info.description) line += `: ${info.description}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Resolves `{{ path.to.field }}` placeholders in a template string against
 * a flat variables object.  Uses the same `resolvePath` + `formatValue`
 * helpers as the rest of the context-resolver so behaviour is consistent.
 *
 * This is the function other modules (e.g. http-request node) should call
 * instead of rolling their own regex replacement.
 */
export function resolveTemplate(template: string, variables: Record<string, unknown>): string {
  return processInterpolations(template, variables);
}

/**
 * Resolves a single `{{ expression }}` template to its raw value (not stringified).
 * Used for map_over to extract arrays from workflow context.
 * Falls back to the raw string if the expression has no `{{ }}` wrappers.
 */
export function resolveTemplateValue(template: string, context: WorkflowContext): unknown {
  const scope = buildScope(undefined, context);
  // If it's a simple {{ expr }} wrapper, resolve to raw value
  const singleExpr = template.trim().match(/^\{\{\s*(.+?)\s*\}\}$/);
  if (singleExpr) {
    return resolvePath(singleExpr[1], scope);
  }
  // Fallback: return as string
  return template;
}

/**
 * Builds the full user-facing prompt for an agent stage.
 *
 * Prompt source:
 * - If an incomingEdge has a prompt_template → resolve with source output
 * - Otherwise → resolve the full trigger payload as context (for trigger-to-agent / gate-to-agent edges)
 *
 * Always appends output requirements from downstream edges.
 */
export function buildAgentPrompt(
  stage: StageDefinition,
  context: WorkflowContext,
  iteration: number,
  options?: {
    incomingEdge?: EdgeDefinition;
    sourceOutput?: unknown;
    /** Fan-in merged outputs keyed by source stage ID. Exposed as {{ sourceOutputs.<stageId>.<field> }} in templates. */
    mergedInputs?: Record<string, unknown>;
    definition?: WorkflowDefinition;
  },
): string {
  const config = stage.config || {};
  const agentId = config.agentId as string | undefined;
  const max_iterations = config.max_iterations as number | undefined;
  const overrides = config.overrides as Record<string, unknown> | undefined;

  // For fan-in stages, use the merged map as the effective sourceOutput so that
  // {{ output.<stageId>.<field> }} still works as a fallback, and expose
  // {{ sourceOutputs.<stageId>.<field> }} for explicit per-source access.
  const effectiveSourceOutput = options?.mergedInputs ?? options?.sourceOutput;

  // Determine the prompt content from the incoming edge
  let resolvedContext: string;
  const incomingPT = options?.incomingEdge ? getEdgePromptTemplate(options.incomingEdge) : undefined;
  if (incomingPT && effectiveSourceOutput !== undefined) {
    // Edge-specific prompt template — resolve with source output (or merged map)
    resolvedContext = resolveEdgeTemplate(incomingPT, effectiveSourceOutput, context, options?.mergedInputs);
  } else if (options?.mergedInputs) {
    // Fan-in with no edge template — show all upstream outputs as context
    resolvedContext = JSON.stringify(options.mergedInputs, null, 2);
  } else {
    // No edge template — provide the trigger payload as default context
    resolvedContext = context.trigger ? JSON.stringify(context.trigger, null, 2) : '';
  }

  const parts: string[] = [];

  // System preamble
  parts.push(`Agent: ${agentId}`);
  if (overrides?.additional_prompt) {
    parts.push(`Additional instructions: ${overrides.additional_prompt}`);
  }

  // Iteration metadata
  if (iteration > 1) {
    const maxStr = max_iterations != null ? ` of max ${max_iterations}` : '';
    parts.push(`This is iteration ${iteration}${maxStr}.`);
  }

  // Resolved context
  if (resolvedContext) {
    parts.push(resolvedContext);
  }

  // Auto-inject output requirements from downstream edges
  if (options?.definition) {
    const requirements = collectOutputRequirements(stage.id, options.definition);
    if (requirements) {
      parts.push(requirements);
    }
  }

  // Inject output schema (JSON Schema) if configured on the agent stage
  if (config.output_schema) {
    const schemaStr = typeof config.output_schema === 'string'
      ? config.output_schema
      : JSON.stringify(config.output_schema, null, 2);
    parts.push(
      'REQUIRED OUTPUT SCHEMA:\n' +
      'Your output (via workflow_signal with status "completed") MUST be a JSON object conforming to this JSON Schema:\n\n' +
      schemaStr + '\n\n' +
      'Ensure every required field is present and types match the schema.',
    );
  }

  // Completion instruction — the agent MUST call workflow_signal to advance the workflow
  parts.push(
    'IMPORTANT: Before you stop, you MUST call the `workflow_signal` tool to indicate your status:\n' +
      '- status="completed" with output={...} if you finished successfully\n' +
      '- status="failed" with error="..." if you cannot continue\n' +
      '- status="waiting_input" with prompt="..." if you need human input\n' +
      'The workflow cannot advance until you call this tool. Do not simply stop — always call `workflow_signal` as your final action.',
  );

  return parts.join('\n\n');
}
