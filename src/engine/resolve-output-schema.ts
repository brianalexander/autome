/**
 * resolve-output-schema — compose a stage's declared output_schema with resolved
 * passthrough fields.
 *
 * The `x-passthrough: 'input'` extension marks a schema field that should be
 * replaced at resolution time by the stage's resolved INPUT schema (the shape
 * of `input.*` references inside templates). This lets gate and review-gate
 * nodes expose typed schemas to downstream consumers without baking the
 * upstream shape into their static declarations.
 *
 * Passthrough chains through multi-hop gate sequences:
 *   A (typed output) → gate1 (passthrough) → gate2 (passthrough) → downstream
 * Downstream sees A's types through both gates.
 *
 * Shape conventions (matching the runtime executor behavior):
 *   - Single upstream (queue mode, any count): input = upstream's raw output (UNWRAPPED)
 *   - Fan-in (input_mode: 'fan_in'): input = { [sourceId]: upstreamOutput, ... } (KEYED)
 *
 * This matches the gate/review-gate executor:
 *   const passthrough = input?.sourceOutput ?? input?.mergedInputs ?? null;
 * where sourceOutput is unwrapped and mergedInputs is keyed.
 */

import { nodeRegistry } from '../nodes/registry.js';
import type { WorkflowDefinition } from '../types/workflow.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a schema has any x-passthrough fields (hot-path short-circuit).
 */
function hasPassthroughFields(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return false;
  return Object.values(properties).some((fieldSchema) => fieldSchema['x-passthrough'] === 'input');
}

/**
 * Resolve the raw output_schema for a given stage — checking stage config first,
 * then falling back to the node type spec's defaultConfig.
 * Does NOT resolve x-passthrough; returns the declared schema as-is.
 */
function getRawOutputSchema(stageId: string, definition: WorkflowDefinition): Record<string, unknown> | undefined {
  const stage = definition.stages?.find((s) => s.id === stageId);
  if (!stage) return undefined;

  const config = (stage.config || {}) as Record<string, unknown>;
  let schema = config.output_schema as Record<string, unknown> | undefined;

  if (!schema) {
    const spec = nodeRegistry.get(stage.type);
    schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
  }

  return schema;
}

/**
 * Resolve the effective OUTPUT schema for a given upstream stage — recursively
 * resolves any passthrough fields so chains work correctly.
 *
 * @param stageId - The stage whose output schema to resolve.
 * @param definition - The full workflow definition.
 * @param visited - Cycle guard: set of stage IDs already being resolved.
 */
function resolveUpstreamOutput(
  stageId: string,
  definition: WorkflowDefinition,
  visited: Set<string>,
): Record<string, unknown> | undefined {
  if (visited.has(stageId)) {
    // Cycle detected — return undefined to break the chain gracefully
    return undefined;
  }
  visited.add(stageId);

  const schema = getRawOutputSchema(stageId, definition);
  if (!schema) return undefined;

  // If this schema has no passthrough fields, return it as-is (fast path)
  if (!hasPassthroughFields(schema)) {
    visited.delete(stageId);
    return schema;
  }

  // Resolve passthrough fields by substituting the stage's effective input schema
  const inputSchema = resolveEffectiveInputSchemaInternal(stageId, definition, visited);
  const resolved = substitutePassthroughFields(schema, inputSchema);

  visited.delete(stageId);
  return resolved;
}

/**
 * Build the effective input schema for a stage — the shape of `input.*` references
 * inside templates and the x-passthrough substitution target.
 *
 * Shape mirrors the runtime executor behavior:
 *   - fan_in: keyed record { [sourceId]: upstreamOutputSchema, ... }
 *   - queue (any edge count): unwrapped upstream schema (one edge fires at a time,
 *     executor delivers input.sourceOutput which is the raw upstream output)
 *   - no incoming edges: undefined
 */
function resolveEffectiveInputSchemaInternal(
  stageId: string,
  definition: WorkflowDefinition,
  visited: Set<string>,
): Record<string, unknown> | undefined {
  const edges = definition.edges ?? [];
  const incomingEdges = edges.filter(
    (e) => e.target === stageId && (e.trigger || 'on_success') === 'on_success',
  );

  if (incomingEdges.length === 0) return undefined;

  const stage = definition.stages?.find((s) => s.id === stageId);
  const inputMode = (stage?.input_mode as string | undefined) ?? 'queue';

  if (inputMode === 'fan_in') {
    // Fan-in: all upstream outputs merged into a keyed record { [sourceId]: schema }
    const properties: Record<string, unknown> = {};
    for (const edge of incomingEdges) {
      const upSchema = resolveUpstreamOutput(edge.source, definition, new Set(visited));
      properties[edge.source] = upSchema ?? { type: 'object' };
    }
    return { type: 'object', properties, required: Object.keys(properties) };
  }

  // Queue mode (default): one edge fires at a time — input is the upstream's raw output,
  // unwrapped. Use the first incoming edge's upstream schema to represent the shape.
  // (For multiple queue edges, each fires independently and all deliver the same unwrapped
  // shape — we use the first as a representative schema.)
  const sourceId = incomingEdges[0].source;
  const upSchema = resolveUpstreamOutput(sourceId, definition, new Set(visited));
  return upSchema ?? { type: 'object' };
}

/**
 * Walk a schema and replace any field with `x-passthrough: 'input'` with the
 * provided inputSchema. Fields without x-passthrough are left unchanged.
 */
function substitutePassthroughFields(
  schema: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return schema;

  const resolvedProperties: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema['x-passthrough'] === 'input') {
      // Replace with the resolved input schema (or an empty-object schema if no upstream)
      resolvedProperties[key] = inputSchema ?? { type: 'object', description: 'No upstream stage connected.' };
    } else {
      resolvedProperties[key] = fieldSchema;
    }
  }

  return { ...schema, properties: resolvedProperties };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective OUTPUT schema for a stage.
 *
 * Walks the declared schema; any field with `x-passthrough: 'input'` is replaced
 * by the stage's resolved INPUT schema (derived from upstream edges). Recursively
 * resolves upstream schemas so passthrough chains through multi-hop gate chains.
 *
 * Passthrough shape mirrors the runtime:
 *   - Single upstream (queue mode): upstream schema UNWRAPPED — matches `input.sourceOutput`
 *   - Fan-in (input_mode: 'fan_in'): keyed record { [sourceId]: schema } — matches `input.mergedInputs`
 *   - Queue with multiple edges: upstream schema unwrapped (one fires at a time)
 *
 * If the declared output_schema has no x-passthrough fields, returns the schema
 * unchanged (hot-path short-circuit). Returns undefined if no output_schema is
 * declared (directly or via node spec defaultConfig).
 */
export function resolveEffectiveOutputSchema(
  stageId: string,
  definition: WorkflowDefinition,
): Record<string, unknown> | undefined {
  const schema = getRawOutputSchema(stageId, definition);
  if (!schema) return undefined;

  // Hot-path: if no x-passthrough fields, return the schema unchanged
  if (!hasPassthroughFields(schema)) return schema;

  const inputSchema = resolveEffectiveInputSchemaInternal(stageId, definition, new Set([stageId]));
  return substitutePassthroughFields(schema, inputSchema);
}

/**
 * Get the resolved INPUT schema for a stage — the shape of `input.*` references
 * inside templates and the passthrough substitution target.
 *
 * Shape mirrors the runtime:
 *   - fan_in: keyed record { [sourceId]: schema }
 *   - queue (default, any edge count): upstream's schema UNWRAPPED (no key)
 *   - no incoming edges: undefined
 *
 * Resolves upstream schemas recursively so passthrough chains work correctly.
 */
export function resolveEffectiveInputSchema(
  stageId: string,
  definition: WorkflowDefinition,
): Record<string, unknown> | undefined {
  return resolveEffectiveInputSchemaInternal(stageId, definition, new Set());
}
