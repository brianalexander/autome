import { nodeRegistry } from '../../nodes/registry.js';
import { canReach } from '../../utils/graph.js';
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
  inputMode?: string,
): Record<string, unknown> | undefined {
  const incomingEdges = (draft.edges || []).filter(
    (e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success',
  );
  if (incomingEdges.length === 0) return undefined;

  // Resolve each upstream's output schema
  function resolveSourceSchema(sourceId: string): Record<string, unknown> {
    const sourceStage = draft.stages?.find((s) => s.id === sourceId);
    const sourceConfig = (sourceStage?.config || {}) as Record<string, unknown>;
    let schema = sourceConfig.output_schema as Record<string, unknown> | undefined;
    if (!schema && sourceStage) {
      const spec = nodeRegistry.get(sourceStage.type);
      schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
    }
    return schema || { type: 'object' };
  }

  // Always namespace by source stage ID — matches runtime ExecutorScope
  const properties: Record<string, unknown> = {};
  for (const edge of incomingEdges) {
    properties[edge.source] = resolveSourceSchema(edge.source);
  }

  if (inputMode === 'fan_in') {
    // fan_in: all inputs arrive together — all keys required
    return { type: 'object', properties, required: Object.keys(properties) };
  }

  // queue mode (default): each message arrives from exactly one upstream at a time.
  // Generate a discriminated union so the code sees only the present key as required.
  if (Object.keys(properties).length === 1) {
    // Single upstream — no union needed, just mark the one key required
    const [key] = Object.keys(properties);
    return { type: 'object', properties, required: [key] };
  }

  return {
    oneOf: Object.entries(properties).map(([key, schema]) => ({
      type: 'object',
      properties: { [key]: schema },
      required: [key],
    })),
  };
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
  stages: Array<{ id: string; type: string; input_mode?: string }>,
  edges: Array<{ source: string; target: string; trigger?: string }>,
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

  // 5. Deadlock detection: fan_in nodes cannot also be cycle-back targets.
  //
  // An edge is a "cycle-back edge" when the edge's source is reachable FROM the
  // target node (i.e., the edge creates a backwards arc in a cycle).  A fan_in
  // node waits for ALL incoming on_success edges before executing.  If any of
  // those edges is a cycle-back, the fan_in will stall on the first run (the
  // cycle-back source hasn't run yet) and on subsequent iterations (only the
  // cycle-back edge fires, not the original upstream edges).
  for (const stage of stages) {
    if (stage.input_mode !== 'fan_in') continue;

    const incomingEdges = edges.filter(
      (e) => e.target === stage.id && (e.trigger || 'on_success') === 'on_success',
    );

    const cycleBackSources: string[] = [];
    const nonCycleSources: string[] = [];
    for (const edge of incomingEdges) {
      // An edge is a cycle-back if the fan_in stage can reach the edge's source
      // by following downstream edges — meaning the source is downstream of this stage.
      if (canReach(stage.id, edge.source, edges)) {
        cycleBackSources.push(edge.source);
      } else {
        nonCycleSources.push(edge.source);
      }
    }

    // Deadlock only occurs when BOTH cycle-back and non-cycle edges exist.
    // If ALL inputs are cycle-back, they all re-fire together on each iteration — no deadlock.
    // If ALL inputs are non-cycle, there's no cycle — no deadlock.
    // The mix is the problem: non-cycle sources fire once, cycle-back sources fire on iteration.
    if (cycleBackSources.length > 0 && nonCycleSources.length > 0) {
      errors.push(
        `Stage "${stage.id}" uses fan_in but has a mix of cycle-back edges (from "${cycleBackSources.join('", "')}") and non-cycle edges (from "${nonCycleSources.join('", "')}") — this creates a deadlock. ` +
          `Fan_in waits for all inputs, but non-cycle sources only fire once while cycle-back sources re-fire on each iteration. ` +
          `Move the cycle target to a separate node, or ensure all inputs are part of the same cycle.`,
      );
    }
  }

  return { errors, warnings };
}
