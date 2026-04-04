import { nodeRegistry } from '../../nodes/registry.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';

// ---------------------------------------------------------------------------
// Upstream output schema lookup
// ---------------------------------------------------------------------------

/**
 * Walk the first incoming edge of a stage to find the source stage's output_schema.
 * Falls back to the node type spec's defaultConfig.output_schema when the stage
 * hasn't declared one explicitly (e.g. cron-trigger always emits a known shape).
 */
export function findUpstreamOutputSchema(
  draft: WorkflowDefinition,
  stageId: string,
): Record<string, unknown> | undefined {
  const incomingEdge = draft.edges?.find((e) => e.target === stageId);
  if (!incomingEdge) return undefined;
  const sourceStage = draft.stages?.find((s) => s.id === incomingEdge.source);
  const sourceConfig = sourceStage?.config as Record<string, unknown> | undefined;
  let schema = sourceConfig?.output_schema as Record<string, unknown> | undefined;
  if (!schema && sourceStage) {
    const spec = nodeRegistry.get(sourceStage.type);
    schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
  }
  return schema;
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
