/**
 * validate-workflow — aggregates all validation checks for a workflow definition
 * into a single function call. Covers graph structure, per-stage config,
 * per-stage code/expression type checking, edge conditions, and schema chain warnings.
 */
import { validateCode, type CodeDiagnostic } from './validate-code.js';
import { validateStageConfig, validateGraphStructure, findUpstreamOutputSchema } from './routes/validation.js';
import { nodeRegistry } from '../nodes/registry.js';
import type { WorkflowDefinition, StageDefinition, EdgeDefinition } from '../schemas/pipeline.js';

export interface StageDiagnostics {
  config: string[];        // config validation errors (required fields, etc.)
  code: CodeDiagnostic[];  // TypeScript diagnostics for code/expression fields
}

export interface EdgeDiagnostics {
  errors: string[];          // structural problems
  condition: CodeDiagnostic[]; // TypeScript diagnostics for condition expressions
}

export interface WorkflowValidationResult {
  valid: boolean;
  summary: string;           // human-readable one-liner
  errors: string[];          // graph-level blocking errors
  warnings: string[];        // graph-level non-blocking warnings
  stages: Record<string, StageDiagnostics>;  // per-stage diagnostics (only stages with issues)
  edges: Record<string, EdgeDiagnostics>;    // per-edge diagnostics (only edges with issues)
}

/**
 * Node types that benefit from output_schema for downstream type checking.
 * Triggers and gates are excluded — they either don't produce output or are pass-through.
 */
const SCHEMA_CHAIN_NODE_TYPES = new Set([
  'code-executor',
  'http-request',
  'shell-executor',
  'transform',
  'agent',
]);

/**
 * Return the edge key used in the `edges` diagnostics record.
 * EdgeDefinition always has a required `id` field; fall back to composite key
 * only as a defensive measure for runtime objects that bypass schema validation.
 */
function edgeKey(edge: EdgeDefinition): string {
  return edge.id || `${edge.source}->${edge.target}`;
}

export function validateWorkflow(draft: WorkflowDefinition): WorkflowValidationResult {
  const stages = draft.stages ?? [];
  const edges = draft.edges ?? [];

  // ------------------------------------------------------------------
  // 1. Graph structure checks
  // ------------------------------------------------------------------
  const graphResult = validateGraphStructure(stages, edges);
  const errors: string[] = [...graphResult.errors];
  const warnings: string[] = [...graphResult.warnings];

  const stageDiagnostics: Record<string, StageDiagnostics> = {};
  const edgeDiagnostics: Record<string, EdgeDiagnostics> = {};

  // Helper to get or create a StageDiagnostics entry
  function getStageEntry(stageId: string): StageDiagnostics {
    if (!stageDiagnostics[stageId]) {
      stageDiagnostics[stageId] = { config: [], code: [] };
    }
    return stageDiagnostics[stageId];
  }

  // Helper to get or create an EdgeDiagnostics entry
  function getEdgeEntry(key: string): EdgeDiagnostics {
    if (!edgeDiagnostics[key]) {
      edgeDiagnostics[key] = { errors: [], condition: [] };
    }
    return edgeDiagnostics[key];
  }

  // ------------------------------------------------------------------
  // 2 & 3. Per-stage config and code validation
  // ------------------------------------------------------------------
  for (const stage of stages) {
    const config = (stage.config ?? {}) as Record<string, unknown>;

    // 2. Config validation — skip trigger stages (no user-facing config to validate)
    if (!nodeRegistry.isTriggerType(stage.type)) {
      const configErrors = validateStageConfig(stage.type, config);
      if (configErrors.length > 0) {
        getStageEntry(stage.id).config.push(...configErrors);
      }
    }

    // 3. Code / expression validation (includes code-trigger which IS a trigger type)
    const upstreamSchema = findUpstreamOutputSchema(draft, stage.id);

    if (stage.type === 'code-executor' || stage.type === 'code-trigger') {
      const code = config.code as string | undefined;
      if (code) {
        const codeDiags = validateCode({
          code,
          outputSchema: upstreamSchema,
          nodeType: stage.type,
          returnSchema: config.output_schema as Record<string, unknown> | undefined,
        });
        if (codeDiags.length > 0) {
          getStageEntry(stage.id).code.push(...codeDiags);
        }
      }
    } else if (stage.type === 'transform') {
      const expression = config.expression as string | undefined;
      if (expression) {
        const exprDiags = validateCode({
          code: expression,
          outputSchema: upstreamSchema,
          validationMode: 'expression',
        });
        if (exprDiags.length > 0) {
          getStageEntry(stage.id).code.push(...exprDiags);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Edge validation
  // ------------------------------------------------------------------
  for (const edge of edges) {
    const key = edgeKey(edge);
    const edgeConfig = edge as EdgeDefinition;

    // Warn if no prompt_template on edges targeting agent stages
    const targetStage = stages.find((s) => s.id === edge.target);
    if (targetStage?.type === 'agent' && !edgeConfig.prompt_template) {
      getEdgeEntry(key).errors.push(
        `Edge to agent stage "${edge.target}" has no prompt_template — the agent will receive no instructions`,
      );
    }

    // Validate condition expressions
    if (edgeConfig.condition) {
      const sourceStage = stages.find((s) => s.id === edge.source);
      const sourceConfig = sourceStage?.config as Record<string, unknown> | undefined;
      const sourceOutputSchema = sourceConfig?.output_schema as Record<string, unknown> | undefined;

      const condDiags = validateCode({
        code: edgeConfig.condition,
        outputSchema: sourceOutputSchema,
        validationMode: 'expression',
      });
      if (condDiags.length > 0) {
        getEdgeEntry(key).condition.push(...condDiags);
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. Schema chain warnings
  // ------------------------------------------------------------------
  // Build a set of stage IDs that have at least one downstream connection
  const stagesWithDownstream = new Set(edges.map((e) => e.source));

  for (const stage of stages) {
    if (!SCHEMA_CHAIN_NODE_TYPES.has(stage.type)) continue;
    if (!stagesWithDownstream.has(stage.id)) continue;

    const config = stage.config as Record<string, unknown> | undefined;
    if (!config?.output_schema) {
      warnings.push(
        `Stage "${stage.id}" (${stage.type}) has downstream connections but no output_schema — downstream type checking will be degraded`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 6. Prune empty stage/edge entries and build summary
  // ------------------------------------------------------------------
  // Remove entries that ended up with no actual issues
  for (const [id, diag] of Object.entries(stageDiagnostics)) {
    if (diag.config.length === 0 && diag.code.length === 0) {
      delete stageDiagnostics[id];
    }
  }
  for (const [key, diag] of Object.entries(edgeDiagnostics)) {
    if (diag.errors.length === 0 && diag.condition.length === 0) {
      delete edgeDiagnostics[key];
    }
  }

  // Count total errors (graph-level + stage config + code errors)
  let totalErrors = errors.length;
  let totalWarnings = warnings.length;

  for (const diag of Object.values(stageDiagnostics)) {
    totalErrors += diag.config.length;
    totalErrors += diag.code.filter((d) => d.severity === 'error').length;
    totalWarnings += diag.code.filter((d) => d.severity === 'warning').length;
  }

  for (const diag of Object.values(edgeDiagnostics)) {
    totalWarnings += diag.errors.length; // edge prompt_template warnings are non-blocking
    totalErrors += diag.condition.filter((d) => d.severity === 'error').length;
    totalWarnings += diag.condition.filter((d) => d.severity === 'warning').length;
  }

  const valid = totalErrors === 0;

  let summary: string;
  if (valid) {
    if (totalWarnings === 0) {
      summary = 'Workflow is valid';
    } else {
      summary = `Workflow is valid (${totalWarnings} ${totalWarnings === 1 ? 'warning' : 'warnings'})`;
    }
  } else {
    const affectedStages = Object.keys(stageDiagnostics).length;
    if (affectedStages > 0) {
      summary = `${totalErrors} ${totalErrors === 1 ? 'error' : 'errors'}, ${totalWarnings} ${totalWarnings === 1 ? 'warning' : 'warnings'} across ${affectedStages} ${affectedStages === 1 ? 'stage' : 'stages'}`;
    } else {
      summary = `${totalErrors} ${totalErrors === 1 ? 'error' : 'errors'}, ${totalWarnings} ${totalWarnings === 1 ? 'warning' : 'warnings'}`;
    }
  }

  return {
    valid,
    summary,
    errors,
    warnings,
    stages: stageDiagnostics,
    edges: edgeDiagnostics,
  };
}
