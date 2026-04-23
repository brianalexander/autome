/**
 * Tests for the frontend resolveEffectiveOutputSchema / resolveEffectiveInputSchema.
 *
 * Mirrors the backend test suite in src/engine/__tests__/resolve-output-schema.test.ts
 * to verify the frontend-side resolver has equivalent behaviour.
 *
 * Shape conventions tested here (must match runtime executor behavior):
 *   - Single upstream (queue mode): x-passthrough resolves to upstream schema DIRECTLY (unwrapped)
 *   - Fan-in (input_mode: 'fan_in'): x-passthrough resolves to { [sourceId]: schema } (keyed)
 *   - Queue with multiple edges: unwrapped (one fires at a time, input.sourceOutput)
 */
import { describe, it, expect } from 'vitest';
import { resolveEffectiveOutputSchema, resolveEffectiveInputSchema } from './resolveOutputSchema';
import type { WorkflowDefinition } from './api';

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
// 1. No x-passthrough → schema unchanged
// ---------------------------------------------------------------------------

describe('no x-passthrough fields', () => {
  it('returns the schema unchanged', () => {
    const schema = {
      type: 'object',
      properties: { plan: { type: 'string' }, score: { type: 'number' } },
      required: ['plan'],
    };
    const wf = makeWorkflow({
      stages: [{ id: 'agent1', type: 'agent', config: { output_schema: schema } }],
    });
    expect(resolveEffectiveOutputSchema('agent1', wf)).toEqual(schema);
  });

  it('returns undefined when no output_schema is present', () => {
    const wf = makeWorkflow({
      stages: [{ id: 's1', type: 'agent', config: {} }],
    });
    expect(resolveEffectiveOutputSchema('s1', wf)).toBeUndefined();
  });

  it('returns undefined for unknown stageId', () => {
    expect(resolveEffectiveOutputSchema('nope', makeWorkflow())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Single upstream passthrough → upstream schema DIRECTLY (not keyed)
// ---------------------------------------------------------------------------

describe('single upstream passthrough', () => {
  it('replaces x-passthrough field with upstream schema DIRECTLY (not wrapped in sourceId key)', () => {
    const upstreamSchema = {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    };
    const wf = makeWorkflow({
      stages: [
        { id: 'src', type: 'agent', config: { output_schema: upstreamSchema } },
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
      edges: [{ id: 'e1', source: 'src', target: 'gate1' }],
    });

    const result = resolveEffectiveOutputSchema('gate1', wf);
    expect(result).toBeDefined();
    const props = result!.properties as Record<string, unknown>;
    expect(props['approved']).toEqual({ type: 'boolean' });

    // input = upstream schema DIRECTLY — NOT { src: upstreamSchema }
    // Matches runtime: gate executor does `passthrough = input?.sourceOutput` (unwrapped)
    expect(props['input']).toEqual(upstreamSchema);
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

  it('falls back to node spec defaultConfig when stage config has no output_schema', () => {
    const specDefaultSchema = {
      type: 'object',
      properties: { value: { type: 'number' } },
    };
    const specs = [{ id: 'custom-node', defaultConfig: { output_schema: specDefaultSchema } }];
    const wf = makeWorkflow({
      stages: [
        { id: 'custom1', type: 'custom-node', config: {} },
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
      edges: [{ id: 'e1', source: 'custom1', target: 'gate1' }],
    });

    // Pass specs so the resolver can fall back to defaultConfig
    const result = resolveEffectiveOutputSchema('gate1', wf, specs as unknown as Parameters<typeof resolveEffectiveOutputSchema>[2]);
    const props = result!.properties as Record<string, unknown>;
    // input = specDefaultSchema DIRECTLY (not keyed)
    expect(props['input']).toEqual(specDefaultSchema);
  });
});

// ---------------------------------------------------------------------------
// 3. Fan-in passthrough → keyed record
// ---------------------------------------------------------------------------

describe('fan-in passthrough', () => {
  it('replaces passthrough field with keyed record of all upstream schemas', () => {
    const schemaA = { type: 'object', properties: { foo: { type: 'string' } } };
    const schemaB = { type: 'object', properties: { bar: { type: 'number' } } };

    const wf = makeWorkflow({
      stages: [
        { id: 'a', type: 'agent', config: { output_schema: schemaA } },
        { id: 'b', type: 'agent', config: { output_schema: schemaB } },
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
        { id: 'e1', source: 'a', target: 'gate_fan' },
        { id: 'e2', source: 'b', target: 'gate_fan' },
      ],
    });

    const result = resolveEffectiveOutputSchema('gate_fan', wf);
    const props = result!.properties as Record<string, unknown>;
    const inputSchema = props['input'] as Record<string, unknown>;
    const inputProps = inputSchema.properties as Record<string, unknown>;
    expect(inputProps['a']).toEqual(schemaA);
    expect(inputProps['b']).toEqual(schemaB);
    expect(inputSchema.required).toEqual(expect.arrayContaining(['a', 'b']));
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
        { id: 'a', type: 'agent', config: { output_schema: schemaA } },
        { id: 'b', type: 'agent', config: { output_schema: schemaB } },
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
        { id: 'e1', source: 'a', target: 'gate_queue' },
        { id: 'e2', source: 'b', target: 'gate_queue' },
      ],
    });

    const result = resolveEffectiveOutputSchema('gate_queue', wf);
    const props = result!.properties as Record<string, unknown>;
    // Queue mode: input resolves to first upstream's schema DIRECTLY (unwrapped, not keyed)
    expect(props['input']).toEqual(schemaA);
  });
});

// ---------------------------------------------------------------------------
// 5. Two-hop chain with single upstream at each hop
// ---------------------------------------------------------------------------

describe('passthrough chain (single upstream at each hop)', () => {
  it('propagates typed schema through multi-hop gate chain without intermediate keying', () => {
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
        { id: 'gate2', type: 'gate', config: { output_schema: gateSchema } },
      ],
      edges: [
        { id: 'e1', source: 'planner', target: 'gate1' },
        { id: 'e2', source: 'gate1', target: 'gate2' },
      ],
    });

    // gate1's resolved output.input = planner's typedSchema DIRECTLY (unwrapped)
    const gate1Result = resolveEffectiveOutputSchema('gate1', wf);
    const gate1Props = gate1Result!.properties as Record<string, unknown>;
    expect(gate1Props['input']).toEqual(typedSchema);

    // gate2's resolved output.input = gate1's resolved output (single upstream, unwrapped)
    // gate1's resolved output = { approved: boolean, input: typedSchema }
    const result = resolveEffectiveOutputSchema('gate2', wf);
    const props = result!.properties as Record<string, unknown>;
    const gate2Input = props['input'] as Record<string, unknown>;
    const gate2InputProps = gate2Input.properties as Record<string, unknown>;
    // No 'gate1' key — input field is gate1's full resolved output schema
    expect(gate2InputProps['approved']).toEqual({ type: 'boolean' });
    // gate1's input field = planner's typedSchema (accessible as output.input.input.plan)
    expect(gate2InputProps['input']).toEqual(typedSchema);
  });

  it('resolveEffectiveInputSchema for downstream sees schema without intermediate stage-id keys', () => {
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
// 6. Cycle safety
// ---------------------------------------------------------------------------

describe('cycle safety', () => {
  it('terminates without infinite recursion on a cyclic definition', () => {
    const gateSchema = {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        input: { 'x-passthrough': 'input' },
      },
    };
    const wf = makeWorkflow({
      stages: [
        { id: 'a', type: 'gate', config: { output_schema: gateSchema } },
        { id: 'b', type: 'gate', config: { output_schema: gateSchema } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    });
    expect(() => resolveEffectiveOutputSchema('a', wf)).not.toThrow();
    expect(() => resolveEffectiveOutputSchema('b', wf)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Missing upstream → passthrough resolves to empty-object schema
// ---------------------------------------------------------------------------

describe('missing upstream', () => {
  it('resolves passthrough to empty-object schema when no upstream exists', () => {
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
    });

    const result = resolveEffectiveOutputSchema('gate1', wf);
    const props = result!.properties as Record<string, unknown>;
    const inputField = props['input'] as Record<string, unknown>;
    expect(inputField.type).toBe('object');
    expect(typeof inputField.description).toBe('string');
  });

  it('resolveEffectiveInputSchema returns undefined with no incoming edges', () => {
    const wf = makeWorkflow({
      stages: [{ id: 'trigger1', type: 'manual-trigger', config: {} }],
    });
    expect(resolveEffectiveInputSchema('trigger1', wf)).toBeUndefined();
  });
});
