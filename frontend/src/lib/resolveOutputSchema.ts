/**
 * resolveOutputSchema — frontend-side resolver for x-passthrough fields.
 *
 * Mirrors the backend logic in src/engine/resolve-output-schema.ts.
 * Uses the workflow definition from the react-query cache (no extra API round-trip).
 *
 * The `x-passthrough: 'input'` extension on a schema field means the field
 * should be replaced by the stage's resolved INPUT schema at display time.
 * This lets gate and review-gate nodes expose typed schemas to downstream
 * consumers in the canvas without baking upstream shapes into static declarations.
 *
 * Passthrough chains through multi-hop gate sequences:
 *   A (typed output) → gate1 (passthrough) → gate2 (passthrough) → downstream
 * Downstream sees A's types through both gates.
 *
 * Shape conventions (matching the runtime executor behavior):
 *   - Single upstream (queue mode, any count): input = upstream's raw output (UNWRAPPED)
 *   - Fan-in (input_mode: 'fan_in'): input = { [sourceId]: upstreamOutput, ... } (KEYED)
 */

import type { WorkflowDefinition, NodeTypeInfo } from './api';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a schema has any x-passthrough fields.
 */
function hasPassthroughFields(schema: Record<string, unknown>): boolean {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return false;
  return Object.values(properties).some((f) => f['x-passthrough'] === 'input');
}

/**
 * Resolve the raw output_schema for a stage — config first, then node spec defaultConfig.
 * Returns the schema as-is without resolving x-passthrough.
 */
function getRawOutputSchema(
  stageId: string,
  definition: WorkflowDefinition,
  specs: NodeTypeInfo[] | undefined,
): Record<string, unknown> | undefined {
  const stage = definition.stages.find((s) => s.id === stageId);
  if (!stage) return undefined;

  const config = (stage.config || {}) as Record<string, unknown>;
  let schema = config.output_schema as Record<string, unknown> | undefined;

  if (!schema && specs) {
    const spec = specs.find((s) => s.id === stage.type);
    schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
  }

  return schema;
}

/**
 * Resolve the effective OUTPUT schema for an upstream stage recursively.
 * Cycle-safe via the visited set.
 */
function resolveUpstreamOutput(
  stageId: string,
  definition: WorkflowDefinition,
  specs: NodeTypeInfo[] | undefined,
  visited: Set<string>,
): Record<string, unknown> | undefined {
  if (visited.has(stageId)) return undefined; // cycle guard
  visited.add(stageId);

  const schema = getRawOutputSchema(stageId, definition, specs);
  if (!schema) {
    visited.delete(stageId);
    return undefined;
  }

  if (!hasPassthroughFields(schema)) {
    visited.delete(stageId);
    return schema;
  }

  // Resolve passthrough fields using this stage's input schema
  const inputSchema = resolveEffectiveInputSchemaInternal(stageId, definition, specs, visited);
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
  specs: NodeTypeInfo[] | undefined,
  visited: Set<string>,
): Record<string, unknown> | undefined {
  const incomingEdges = definition.edges.filter(
    (e) => e.target === stageId && ((e as Record<string, unknown>).trigger || 'on_success') === 'on_success',
  );

  if (incomingEdges.length === 0) return undefined;

  const stage = definition.stages.find((s) => s.id === stageId);
  const inputMode = (stage as Record<string, unknown> | undefined)?.['input_mode'] as string | undefined ?? 'queue';

  if (inputMode === 'fan_in') {
    // Fan-in: all upstream outputs merged into a keyed record { [sourceId]: schema }
    const properties: Record<string, unknown> = {};
    for (const edge of incomingEdges) {
      const upSchema = resolveUpstreamOutput(edge.source, definition, specs, new Set(visited));
      properties[edge.source] = upSchema ?? { type: 'object' };
    }
    return { type: 'object', properties, required: Object.keys(properties) };
  }

  // Queue mode (default): one edge fires at a time — input is the upstream's raw output,
  // unwrapped. Use the first incoming edge's upstream schema to represent the shape.
  // (For multiple queue edges, each fires independently and all deliver the same unwrapped
  // shape — we use the first as a representative schema.)
  const sourceId = incomingEdges[0].source;
  const upSchema = resolveUpstreamOutput(sourceId, definition, specs, new Set(visited));
  return upSchema ?? { type: 'object' };
}

/**
 * Replace x-passthrough fields in a schema with the provided inputSchema.
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
 * Resolve the effective OUTPUT schema for a stage, substituting any
 * `x-passthrough: 'input'` fields with the stage's resolved input schema.
 *
 * Pass `specs` (from the `/api/node-types` response) so the resolver can fall
 * back to node spec defaultConfig when a stage hasn't declared its own output_schema.
 *
 * Passthrough shape mirrors the runtime:
 *   - Single upstream (queue mode): upstream schema UNWRAPPED — matches `input.sourceOutput`
 *   - Fan-in (input_mode: 'fan_in'): keyed record { [sourceId]: schema } — matches `input.mergedInputs`
 *   - Queue with multiple edges: upstream schema unwrapped (one fires at a time)
 *
 * Returns undefined if no output_schema is found.
 * Returns the schema unchanged if no x-passthrough fields are present (fast path).
 */
export function resolveEffectiveOutputSchema(
  stageId: string,
  definition: WorkflowDefinition,
  specs?: NodeTypeInfo[],
): Record<string, unknown> | undefined {
  const schema = getRawOutputSchema(stageId, definition, specs);
  if (!schema) return undefined;
  if (!hasPassthroughFields(schema)) return schema;

  const inputSchema = resolveEffectiveInputSchemaInternal(stageId, definition, specs, new Set([stageId]));
  return substitutePassthroughFields(schema, inputSchema);
}

/**
 * Get the resolved INPUT schema for a stage — the shape of `input.*` references.
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
  specs?: NodeTypeInfo[],
): Record<string, unknown> | undefined {
  return resolveEffectiveInputSchemaInternal(stageId, definition, specs, new Set());
}
