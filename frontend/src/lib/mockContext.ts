/**
 * mockContext — synthesizes a fake workflow context for template preview.
 *
 * Walks the workflow graph upstream from a given stage, samples each node's
 * output_schema to generate plausible dummy values, and builds a context object
 * that mirrors what gates and agents see at runtime:
 *
 *   { trigger: { ... }, stages: { [stageId]: { latest: { ... } } } }
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

// ---------------------------------------------------------------------------
// Mock context synthesis
// ---------------------------------------------------------------------------

export interface MockWorkflowContext {
  trigger: Record<string, unknown>;
  stages: Record<string, { latest: unknown }>;
}

/**
 * Build a mock workflow context for template preview.
 *
 * Strategy:
 * 1. Walk upstream from the target stage to find all ancestor stage IDs.
 * 2. For each ancestor that is a trigger, sample its output_schema → becomes `trigger`.
 * 3. For each non-trigger ancestor, sample its output_schema → becomes `stages.<id>.latest`.
 * 4. If no trigger found upstream, use a generic fallback trigger payload.
 */
export function buildMockContext(
  stageId: string,
  definition: WorkflowDefinition,
): MockWorkflowContext {
  const upstreamIds = findUpstreamStageIds(stageId, definition);

  const stagesScope: Record<string, { latest: unknown }> = {};
  let trigger: Record<string, unknown> = { prompt: 'Sample prompt', data: 'Sample data' };
  let foundTrigger = false;

  for (const upId of upstreamIds) {
    const stageDef = definition.stages.find((s) => s.id === upId);
    if (!stageDef) continue;

    const isTrigger = stageDef.type === 'trigger' || stageDef.type.endsWith('-trigger');
    const config = (stageDef.config || {}) as Record<string, unknown>;
    const outputSchema = config['output_schema'] as Record<string, unknown> | undefined;
    const sampled = outputSchema ? sampleFromSchema(outputSchema, upId) : {};

    if (isTrigger && !foundTrigger) {
      // Use the trigger's sampled output as the trigger context
      trigger = (typeof sampled === 'object' && sampled !== null && !Array.isArray(sampled))
        ? (sampled as Record<string, unknown>)
        : { payload: sampled };
      foundTrigger = true;
    }

    // All upstream stages (including triggers) get entries in stages scope
    stagesScope[upId] = { latest: sampled };
  }

  return { trigger, stages: stagesScope };
}
