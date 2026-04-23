/**
 * Tests for resolveEffectiveOutputSchema and resolveEffectiveInputSchema.
 *
 * All stage configs include an explicit output_schema so the node registry
 * fallback is not exercised (registry is not initialized in unit tests).
 *
 * Shape conventions tested here (must match runtime executor behavior):
 *   - Single upstream (queue mode): x-passthrough resolves to upstream schema DIRECTLY (unwrapped)
 *   - Fan-in (input_mode: 'fan_in'): x-passthrough resolves to { [sourceId]: schema } (keyed)
 *   - Queue with multiple edges: unwrapped (one fires at a time, input.sourceOutput)
 */
import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveOutputSchema,
  resolveEffectiveInputSchema,
} from '../resolve-output-schema.js';
import type { WorkflowDefinition } from '../../types/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Stage with no x-passthrough → returns schema unchanged
// ---------------------------------------------------------------------------

describe('no x-passthrough fields', () => {
  it('returns the schema unchanged when no passthrough fields exist', () => {
    const wf = makeWorkflow({
      stages: [
        {
          id: 'agent1',
          type: 'agent',
          config: {
            output_schema: {
              type: 'object',
              properties: {
                plan: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['plan'],
            },
          },
        },
      ],
    });

    const result = resolveEffectiveOutputSchema('agent1', wf);
    expect(result).toEqual({
      type: 'object',
      properties: {
        plan: { type: 'string' },
        score: { type: 'number' },
      },
      required: ['plan'],
    });
  });

  it('returns undefined when stage has no output_schema', () => {
    const wf = makeWorkflow({
      stages: [{ id: 'stage1', type: 'agent', config: {} }],
    });
    expect(resolveEffectiveOutputSchema('stage1', wf)).toBeUndefined();
  });

  it('returns undefined for unknown stageId', () => {
    const wf = makeWorkflow();
    expect(resolveEffectiveOutputSchema('nonexistent', wf)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Single upstream + x-passthrough → UNWRAPPED upstream schema (no keying)
// ---------------------------------------------------------------------------

describe('single upstream passthrough', () => {
  it('replaces x-passthrough: input field with the upstream schema DIRECTLY (not keyed)', () => {
    const upstreamSchema = {
      type: 'object',
      properties: {
        content: { type: 'string' },
        score: { type: 'number' },
      },
      required: ['content'],
    };

    const wf = makeWorkflow({
      stages: [
        {
          id: 'agent1',
          type: 'agent',
          config: { output_schema: upstreamSchema },
        },
        {
          id: 'gate1',
          type: 'gate',
          config: {
            output_schema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                input: { 'x-passthrough': 'input' },
              },
              required: ['approved', 'input'],
            },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'agent1', target: 'gate1' }],
    });

    const result = resolveEffectiveOutputSchema('gate1', wf);
    expect(result).toBeDefined();
    const props = result!.properties as Record<string, unknown>;

    // approved stays typed
    expect(props['approved']).toEqual({ type: 'boolean' });

    // input is replaced with the upstream schema DIRECTLY — NOT wrapped in { agent1: ... }
    // Matches runtime: gate executor does `passthrough = input?.sourceOutput` (unwrapped)
    expect(props['input']).toEqual(upstreamSchema);
  });

  it('non-passthrough fields survive substitution unchanged', () => {
    const wf = makeWorkflow({
      stages: [
        {
          id: 'src',
          type: 'agent',
          config: { output_schema: { type: 'object', properties: { x: { type: 'string' } } } },
        },
        {
          id: 'gate1',
          type: 'gate',
          config: {
            output_schema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', description: 'Gate decision' },
                input: { 'x-passthrough': 'input' },
              },
              required: ['approved', 'input'],
            },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'gate1' }],
    });

    const result = resolveEffectiveOutputSchema('gate1', wf);
    const props = result!.properties as Record<string, unknown>;
    expect(props['approved']).toEqual({ type: 'boolean', description: 'Gate decision' });
  });

  it('resolveEffectiveInputSchema for single upstream returns upstream schema unwrapped', () => {
    const upstreamSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const wf = makeWorkflow({
      stages: [
        { id: 'src', type: 'agent', config: { output_schema: upstreamSchema } },
        { id: 'gate1', type: 'gate', config: { output_schema: { type: 'object', properties: {} } } },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'gate1' }],
    });

    // input schema = upstream schema directly, allowing {{ input.title }} (not {{ input.src.title }})
    const inputSchema = resolveEffectiveInputSchema('gate1', wf);
    expect(inputSchema).toEqual(upstreamSchema);
  });
});

// ---------------------------------------------------------------------------
// 3. Fan-in passthrough → keyed record (UNCHANGED behavior)
// ---------------------------------------------------------------------------

describe('fan-in passthrough', () => {
  it('replaces passthrough field with keyed record of upstream schemas', () => {
    const schemaA = { type: 'object', properties: { foo: { type: 'string' } } };
    const schemaB = { type: 'object', properties: { bar: { type: 'number' } } };

    const wf = makeWorkflow({
      stages: [
        { id: 'stageA', type: 'agent', config: { output_schema: schemaA } },
        { id: 'stageB', type: 'agent', config: { output_schema: schemaB } },
        {
          id: 'gate_fan',
          type: 'gate',
          input_mode: 'fan_in',
          config: {
            output_schema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                input: { 'x-passthrough': 'input' },
              },
            },
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'stageA', target: 'gate_fan' },
        { id: 'e2', source: 'stageB', target: 'gate_fan' },
      ],
    });

    const result = resolveEffectiveOutputSchema('gate_fan', wf);
    const props = result!.properties as Record<string, unknown>;
    const inputSchema = props['input'] as Record<string, unknown>;

    // Fan-in: both stages keyed — matches runtime mergedInputs
    expect(inputSchema.type).toBe('object');
    const inputProps = inputSchema.properties as Record<string, unknown>;
    expect(inputProps['stageA']).toEqual(schemaA);
    expect(inputProps['stageB']).toEqual(schemaB);
    // Both required (fan_in semantics)
    expect(inputSchema.required).toEqual(expect.arrayContaining(['stageA', 'stageB']));
  });
});

// ---------------------------------------------------------------------------
// 4. Queue mode with 2+ incoming edges → UNWRAPPED (one fires at a time)
// ---------------------------------------------------------------------------

describe('queue mode with multiple incoming edges', () => {
  it('resolves passthrough to unwrapped upstream schema (first edge representative)', () => {
    const schemaA = { type: 'object', properties: { foo: { type: 'string' } } };
    const schemaB = { type: 'object', properties: { bar: { type: 'number' } } };

    const wf = makeWorkflow({
      stages: [
        { id: 'stageA', type: 'agent', config: { output_schema: schemaA } },
        { id: 'stageB', type: 'agent', config: { output_schema: schemaB } },
        {
          id: 'gate_queue',
          type: 'gate',
          // No input_mode → defaults to 'queue'
          config: {
            output_schema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                input: { 'x-passthrough': 'input' },
              },
            },
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'stageA', target: 'gate_queue' },
        { id: 'e2', source: 'stageB', target: 'gate_queue' },
      ],
    });

    const result = resolveEffectiveOutputSchema('gate_queue', wf);
    const props = result!.properties as Record<string, unknown>;

    // Queue mode: input resolves to first upstream's schema DIRECTLY (unwrapped, not keyed)
    // Matches runtime: one edge fires at a time, delivering input.sourceOutput (unwrapped)
    expect(props['input']).toEqual(schemaA);
  });

  it('resolveEffectiveInputSchema for queue with 2+ edges returns first upstream unwrapped', () => {
    const schemaA = { type: 'object', properties: { value: { type: 'number' } } };
    const wf = makeWorkflow({
      stages: [
        { id: 'a', type: 'agent', config: { output_schema: schemaA } },
        { id: 'b', type: 'agent', config: { output_schema: { type: 'object', properties: {} } } },
        { id: 'gate1', type: 'gate', config: { output_schema: { type: 'object', properties: {} } } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'gate1' },
        { id: 'e2', source: 'b', target: 'gate1' },
      ],
    });

    const inputSchema = resolveEffectiveInputSchema('gate1', wf);
    // Unwrapped — schema of first upstream
    expect(inputSchema).toEqual(schemaA);
  });
});

// ---------------------------------------------------------------------------
// 5. Two-hop chain with single upstream at each hop
// ---------------------------------------------------------------------------

describe('passthrough chains (single upstream at each hop)', () => {
  it('downstream sees A\'s fields via resolved.properties.input.properties.title (no intermediate keying)', () => {
    const typedSchema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Result title' },
        confidence: { type: 'number' },
      },
      required: ['title'],
    };

    const gateSchema = {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        input: { 'x-passthrough': 'input' },
      },
      required: ['approved', 'input'],
    };

    const wf = makeWorkflow({
      stages: [
        { id: 'stageA', type: 'agent', config: { output_schema: typedSchema } },
        { id: 'gateB', type: 'gate', config: { output_schema: gateSchema } },
        { id: 'gateC', type: 'gate', config: { output_schema: gateSchema } },
        { id: 'downstream', type: 'agent', config: { output_schema: { type: 'object' } } },
      ],
      edges: [
        { id: 'e1', source: 'stageA', target: 'gateB' },
        { id: 'e2', source: 'gateB', target: 'gateC' },
        { id: 'e3', source: 'gateC', target: 'downstream' },
      ],
    });

    // gateB's resolved output.input = stageA's schema DIRECTLY (unwrapped, single upstream)
    const gateBResult = resolveEffectiveOutputSchema('gateB', wf);
    const gateBProps = gateBResult!.properties as Record<string, unknown>;
    expect(gateBProps['input']).toEqual(typedSchema);

    // gateC's resolved output.input = gateB's resolved output schema (single upstream, unwrapped)
    // gateB's resolved output is { approved: boolean, input: typedSchema }
    const gateCResult = resolveEffectiveOutputSchema('gateC', wf);
    const gateCProps = gateCResult!.properties as Record<string, unknown>;
    const gateCInput = gateCProps['input'] as Record<string, unknown>;
    // gateCInput = gateB's resolved output — has 'approved' and 'input' (= typedSchema)
    expect(gateCInput.type).toBe('object');
    const gateCInputProps = gateCInput.properties as Record<string, unknown>;
    expect(gateCInputProps['approved']).toEqual({ type: 'boolean' });
    // The inner 'input' is stageA's typedSchema — accessible as output.input.input.title
    // (two hops of passthrough)
    expect(gateCInputProps['input']).toEqual(typedSchema);

    // Downstream's input schema = gateC's resolved output (single upstream, unwrapped — no 'gateC' key)
    const downstreamInput = resolveEffectiveInputSchema('downstream', wf);
    const downstreamInputProps = (downstreamInput as Record<string, unknown>)?.properties as Record<string, unknown>;
    // gateC's resolved output has approved + input (= gateB's resolved output)
    // gateB's resolved output has approved + input (= typedSchema)
    // So downstream.input.input = typedSchema (two hops of passthrough chaining)
    const downstreamInnerInput = (downstreamInputProps?.['input'] as Record<string, unknown>)?.properties as Record<string, unknown>;
    expect(downstreamInnerInput?.['input']).toEqual(typedSchema);
  });

  it('resolveEffectiveInputSchema for downstream sees typed data through gate chain (no intermediate keying)', () => {
    const typedSchema = {
      type: 'object',
      properties: { plan: { type: 'string' } },
      required: ['plan'],
    };
    const gateSchema = {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        input: { 'x-passthrough': 'input' },
      },
    };

    const wf = makeWorkflow({
      stages: [
        { id: 'planner', type: 'agent', config: { output_schema: typedSchema } },
        { id: 'gate1', type: 'gate', config: { output_schema: gateSchema } },
        { id: 'executor', type: 'agent', config: { output_schema: { type: 'object' } } },
      ],
      edges: [
        { id: 'e1', source: 'planner', target: 'gate1' },
        { id: 'e2', source: 'gate1', target: 'executor' },
      ],
    });

    // executor's input schema = gate1's resolved output (single upstream, unwrapped — no 'gate1' key)
    const inputSchema = resolveEffectiveInputSchema('executor', wf);
    expect(inputSchema).toBeDefined();
    // gate1's resolved output has 'approved' and 'input' = planner's typedSchema
    const inputProps = (inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(inputProps['approved']).toEqual({ type: 'boolean' });
    expect(inputProps['input']).toEqual(typedSchema);
  });
});

// ---------------------------------------------------------------------------
// 6. Cycle-safe: manually constructed cycle should terminate
// ---------------------------------------------------------------------------

describe('cycle safety', () => {
  it('terminates without infinite recursion on a definition with a cycle', () => {
    // stageA → stageB → stageA (cycle)
    // Both have passthrough — would infinite loop without visited set.
    const gateSchema = {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        input: { 'x-passthrough': 'input' },
      },
    };

    const wf = makeWorkflow({
      stages: [
        { id: 'stageA', type: 'gate', config: { output_schema: gateSchema } },
        { id: 'stageB', type: 'gate', config: { output_schema: gateSchema } },
      ],
      edges: [
        { id: 'e1', source: 'stageA', target: 'stageB' },
        { id: 'e2', source: 'stageB', target: 'stageA' }, // cycle-back
      ],
    });

    // Should complete without throwing a stack overflow or hanging
    expect(() => resolveEffectiveOutputSchema('stageA', wf)).not.toThrow();
    expect(() => resolveEffectiveOutputSchema('stageB', wf)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Missing upstream: no inbound edges → passthrough resolves to empty-object schema
// ---------------------------------------------------------------------------

describe('missing upstream', () => {
  it('resolves passthrough to empty-object schema when there is no upstream', () => {
    const wf = makeWorkflow({
      stages: [
        {
          id: 'gate1',
          type: 'gate',
          config: {
            output_schema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                input: { 'x-passthrough': 'input' },
              },
            },
          },
        },
      ],
      // No edges → no upstream
    });

    const result = resolveEffectiveOutputSchema('gate1', wf);
    const props = result!.properties as Record<string, unknown>;
    const inputField = props['input'] as Record<string, unknown>;
    // Should be the fallback schema (description mentions no upstream)
    expect(inputField.type).toBe('object');
    expect(inputField.description).toMatch(/no upstream/i);
  });

  it('resolveEffectiveInputSchema returns undefined for a stage with no incoming edges', () => {
    const wf = makeWorkflow({
      stages: [{ id: 'trigger1', type: 'manual-trigger', config: {} }],
    });
    expect(resolveEffectiveInputSchema('trigger1', wf)).toBeUndefined();
  });
});
