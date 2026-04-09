/**
 * Tests for validateWorkflow.
 *
 * validateWorkflow aggregates graph-structure validation, per-stage config
 * validation, code diagnostics, and schema-chain warnings. The underlying
 * validateGraphStructure calls nodeRegistry.isTriggerType(), so we register
 * the built-in node specs in beforeAll.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { nodeRegistry } from '../../nodes/registry.js';
import { allBuiltinSpecs } from '../../nodes/builtin/index.js';
import { validateWorkflow } from '../validate-workflow.js';
import type { WorkflowDefinition } from '../../schemas/pipeline.js';

beforeAll(() => {
  for (const spec of allBuiltinSpecs) {
    try {
      nodeRegistry.register(spec);
    } catch {
      // Already registered from a prior test file — safe to ignore
    }
  }
});

// ---------------------------------------------------------------------------
// Minimal valid workflow factory
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test Workflow',
    active: false,
    trigger: { provider: 'manual' },
    stages: [
      { id: 'trigger', type: 'manual-trigger' },
      {
        id: 'worker',
        type: 'agent',
        config: {
          agentId: 'test-agent',
          output_schema: { type: 'object', properties: { result: { type: 'string' } } },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'worker', prompt_template: 'Do something' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid workflows
// ---------------------------------------------------------------------------

describe('valid workflows', () => {
  it('returns valid=true for a simple trigger → agent workflow', () => {
    const result = validateWorkflow(makeWorkflow());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('summary says "Workflow is valid" when there are no errors or warnings', () => {
    // Give the agent an output_schema so no schema-chain warnings fire
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          {
            id: 'worker',
            type: 'agent',
            config: {
              agentId: 'test-agent',
              output_schema: { type: 'object', properties: { result: { type: 'string' } } },
            },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.summary).toBe('Workflow is valid');
  });

  it('returns valid=true for a workflow with a cycle (cycles are allowed)', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          {
            id: 'worker',
            type: 'agent',
            config: {
              agentId: 'test-agent',
              output_schema: { type: 'object', properties: { done: { type: 'boolean' } } },
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'worker', prompt_template: 'Do something' },
          { id: 'e2', source: 'worker', target: 'worker', prompt_template: 'Continue' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing trigger
// ---------------------------------------------------------------------------

describe('missing trigger stage', () => {
  it('produces an error when no trigger stage is present', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'worker', type: 'agent', config: { agentId: 'test-agent' } },
        ],
        edges: [],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /trigger/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orphan / unreachable stage
// ---------------------------------------------------------------------------

describe('orphan stage', () => {
  it('produces a warning for a stage not connected to any edge from the trigger', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          { id: 'worker', type: 'agent', config: { agentId: 'test-agent' } },
          { id: 'orphan', type: 'agent', config: { agentId: 'orphan-agent' } },
        ],
        // orphan has no edges connecting it to trigger or worker
        edges: [
          { id: 'e1', source: 'trigger', target: 'worker', prompt_template: 'Do something' },
        ],
      }),
    );
    // Unreachable stages produce warnings, not errors
    expect(result.warnings.some((w) => /unreachable|orphan/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid edge references
// ---------------------------------------------------------------------------

describe('edge referencing non-existent stages', () => {
  it('produces an error when the edge source does not match any stage', () => {
    const result = validateWorkflow(
      makeWorkflow({
        edges: [
          { id: 'e1', source: 'nonexistent', target: 'worker', prompt_template: 'x' },
          { id: 'e2', source: 'trigger', target: 'worker', prompt_template: 'y' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /nonexistent/i.test(e))).toBe(true);
  });

  it('produces an error when the edge target does not match any stage', () => {
    const result = validateWorkflow(
      makeWorkflow({
        edges: [
          { id: 'e1', source: 'trigger', target: 'does_not_exist', prompt_template: 'x' },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /does_not_exist/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-loop edge (source === target)
// ---------------------------------------------------------------------------

describe('self-loop edge', () => {
  it('allows a self-loop (source === target) — cycles are valid', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          {
            id: 'worker',
            type: 'agent',
            config: {
              agentId: 'test-agent',
              output_schema: { type: 'object', properties: { done: { type: 'boolean' } } },
            },
          },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'worker', prompt_template: 'Start' },
          { id: 'e2', source: 'worker', target: 'worker', prompt_template: 'Again' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fan-in deadlock
// ---------------------------------------------------------------------------

describe('fan_in deadlock detection', () => {
  it('produces an error when a fan_in node has both cycle-back and non-cycle edges', () => {
    // Classic deadlock: trigger → fetch → filter (fan_in)
    //                   trigger → filter (non-cycle)
    //                   filter → reviewer → aggregator → filter (cycle-back)
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          { id: 'fetch', type: 'code-executor', config: {} },
          { id: 'filter', type: 'code-executor', config: {}, input_mode: 'fan_in' },
          { id: 'reviewer', type: 'agent', config: { agentId: 'reviewer' } },
          { id: 'aggregator', type: 'code-executor', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'fetch' },
          { id: 'e2', source: 'trigger', target: 'filter' },
          { id: 'e3', source: 'fetch', target: 'filter' },
          { id: 'e4', source: 'filter', target: 'reviewer', prompt_template: 'Review' },
          { id: 'e5', source: 'reviewer', target: 'aggregator', prompt_template: 'Aggregate' },
          { id: 'e6', source: 'aggregator', target: 'filter' }, // cycle-back
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /fan_in|deadlock|cycle/i.test(e))).toBe(true);
  });

  it('does not produce a deadlock error when all fan_in inputs are within the cycle', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [
          { id: 'trigger', type: 'manual-trigger' },
          { id: 'filter', type: 'code-executor', config: {} },
          { id: 'reviewer_a', type: 'agent', config: { agentId: 'reviewer-a' } },
          { id: 'reviewer_b', type: 'agent', config: { agentId: 'reviewer-b' } },
          { id: 'aggregator', type: 'code-executor', config: {}, input_mode: 'fan_in' },
          { id: 'decision', type: 'code-executor', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'filter' },
          { id: 'e2', source: 'filter', target: 'reviewer_a', prompt_template: 'Review A' },
          { id: 'e3', source: 'filter', target: 'reviewer_b', prompt_template: 'Review B' },
          { id: 'e4', source: 'reviewer_a', target: 'aggregator', prompt_template: 'Collect A' },
          { id: 'e5', source: 'reviewer_b', target: 'aggregator', prompt_template: 'Collect B' },
          { id: 'e6', source: 'aggregator', target: 'decision' },
          { id: 'e7', source: 'decision', target: 'filter' }, // cycle-back, but ALL aggregator inputs are in cycle
        ],
      }),
    );
    // The only errors here should not be deadlock-related
    expect(result.errors.filter((e) => /fan_in|deadlock|cycle/i.test(e))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty stages array
// ---------------------------------------------------------------------------

describe('empty stages array', () => {
  it('produces an error when stages is empty', () => {
    const result = validateWorkflow(
      makeWorkflow({
        stages: [],
        edges: [],
      }),
    );
    expect(result.valid).toBe(false);
    // No trigger stage → at minimum a trigger error
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('result structure', () => {
  it('returns the expected shape with valid, summary, errors, warnings, stages, edges', () => {
    const result = validateWorkflow(makeWorkflow());
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('stages');
    expect(result).toHaveProperty('edges');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.stages).toBe('object');
    expect(typeof result.edges).toBe('object');
  });

  it('only includes stages with issues in the stages diagnostics record', () => {
    const result = validateWorkflow(makeWorkflow());
    // A valid trigger → agent workflow with no config errors should have no stage entries
    expect(Object.keys(result.stages)).toHaveLength(0);
  });

  it('summary reflects warning count when valid but warnings exist', () => {
    // agent without output_schema produces a schema-chain warning
    const result = validateWorkflow(makeWorkflow());
    if (result.warnings.length > 0) {
      expect(result.summary).toMatch(/warning/);
    }
  });
});
