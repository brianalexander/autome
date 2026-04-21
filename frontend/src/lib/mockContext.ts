/**
 * mockContext — synthesizes a fake workflow context for template preview.
 *
 * Walks the workflow graph upstream from a given stage, samples each node's
 * output_schema to generate plausible dummy values, and builds a narrowed context
 * object matching the template scope policy:
 *
 *   { trigger: { ... }, input: { ... }, output: { ... } }
 *
 * - `trigger` — sampled from the trigger node's output_schema
 * - `input`   — sampled from the immediate upstream stage's output_schema (edge-delivered data)
 * - `output`  — alias for input (used in outbound-edge templates)
 *
 * `stages.*` is intentionally NOT included — user templates cannot reach across stages.
 *
 * Used by PreviewTemplateCard to render live Nunjucks previews in the canvas.
 */

import type { StageDefinition, WorkflowDefinition } from './api';

// ---------------------------------------------------------------------------
// Schema-based value synthesis
// ---------------------------------------------------------------------------

/**
 * Recursively synthesize a dummy value from a JSON Schema node.
 * Produces human-readable sample data so the preview is meaningful.
 */
export function sampleFromSchema(schema: Record<string, unknown> | undefined, key?: string): unknown {
  if (!schema) return 'sample';

  const type = schema['type'] as string | undefined;
  const title = (schema['title'] as string | undefined) || key || 'value';

  switch (type) {
    case 'string':
      return `Sample ${title}`;
    case 'number':
    case 'integer':
      return 42;
    case 'boolean':
      return true;
    case 'array': {
      const items = schema['items'] as Record<string, unknown> | undefined;
      return [sampleFromSchema(items, 'item')];
    }
    case 'object': {
      const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
      if (!props) return {};
      const result: Record<string, unknown> = {};
      for (const [propKey, propSchema] of Object.entries(props)) {
        result[propKey] = sampleFromSchema(propSchema, propKey);
      }
      return result;
    }
    default:
      // No type hint — return a plausible string
      return `Sample ${title}`;
  }
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

/**
 * Returns the set of stage IDs that are upstream (ancestors) of the given stage.
 * Performs a BFS over incoming edges.
 */
function findUpstreamStageIds(stageId: string, definition: WorkflowDefinition): Set<string> {
  const upstream = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of definition.edges) {
      if (edge.target === current && !upstream.has(edge.source)) {
        upstream.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  return upstream;
}

/**
 * Find the immediate parent stage ID (closest upstream, non-trigger) for a given stage.
 * Returns undefined if no non-trigger upstream exists.
 */
function findImmediateUpstream(stageId: string, definition: WorkflowDefinition): string | undefined {
  // Direct incoming edges from non-trigger stages
  const incomingEdges = definition.edges.filter((e) => e.target === stageId);
  for (const edge of incomingEdges) {
    const srcStage = definition.stages.find((s) => s.id === edge.source);
    if (srcStage && !srcStage.type.endsWith('-trigger') && srcStage.type !== 'trigger') {
      return edge.source;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Mock context synthesis
// ---------------------------------------------------------------------------

export interface MockWorkflowContext {
  /** Workflow-level trigger payload */
  trigger: Record<string, unknown>;
  /** Edge-delivered upstream data (for incoming-edge templates and stage config templates) */
  input: Record<string, unknown>;
  /** Alias for input — used in outbound-edge templates where source stage output is `output` */
  output: Record<string, unknown>;
}

/**
 * Build a narrowed mock workflow context for template preview.
 *
 * Exposed variables match the runtime policy:
 *   - `trigger` — sampled from the trigger node's output_schema
 *   - `input`   — sampled from the immediate upstream stage's output_schema
 *   - `output`  — alias of input (for outbound-edge templates)
 *
 * `stages.*` is intentionally excluded — templates cannot reach across stages.
 */
export function buildMockContext(
  stageId: string,
  definition: WorkflowDefinition,
): MockWorkflowContext {
  const upstreamIds = findUpstreamStageIds(stageId, definition);

  let trigger: Record<string, unknown> = { prompt: 'Sample prompt', data: 'Sample data' };
  let input: Record<string, unknown> = {};

  for (const upId of upstreamIds) {
    const stageDef = definition.stages.find((s) => s.id === upId);
    if (!stageDef) continue;

    const isTrigger = stageDef.type === 'trigger' || stageDef.type.endsWith('-trigger');
    const config = (stageDef.config || {}) as Record<string, unknown>;
    const outputSchema = config['output_schema'] as Record<string, unknown> | undefined;
    const sampled = outputSchema ? sampleFromSchema(outputSchema, upId) : {};

    if (isTrigger) {
      // Use the trigger's sampled output as the trigger context
      trigger = (typeof sampled === 'object' && sampled !== null && !Array.isArray(sampled))
        ? (sampled as Record<string, unknown>)
        : { payload: sampled };
    }
  }

  // input = the immediate upstream non-trigger stage's sampled output
  const immediateUpstreamId = findImmediateUpstream(stageId, definition);
  if (immediateUpstreamId) {
    const stageDef = definition.stages.find((s) => s.id === immediateUpstreamId);
    if (stageDef) {
      const config = (stageDef.config || {}) as Record<string, unknown>;
      const outputSchema = config['output_schema'] as Record<string, unknown> | undefined;
      const sampled = outputSchema ? sampleFromSchema(outputSchema, immediateUpstreamId) : {};
      input = (typeof sampled === 'object' && sampled !== null && !Array.isArray(sampled))
        ? (sampled as Record<string, unknown>)
        : { data: sampled };
    }
  }

  return { trigger, input, output: input };
}
