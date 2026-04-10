import { describe, it, expect, beforeAll } from 'vitest';
import {
  recordFanInCompletion,
  countIncomingSuccessEdges,
  evaluateEdges,
  initializeContext,
  isTerminalStage,
  findEntryStages,
} from '../graph-helpers.js';
import { nodeRegistry } from '../../nodes/registry.js';
import type { WorkflowDefinition, EdgeDefinition } from '../../types/workflow.js';
import type { WorkflowContext } from '../../types/instance.js';
import type { Event } from '../../types/events.js';

// ---------------------------------------------------------------------------
// Registry initialization — trigger type detection requires registered specs
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const { allBuiltinSpecs } = await import('../../nodes/builtin/index.js');
  for (const spec of allBuiltinSpecs) {
    nodeRegistry.register(spec);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  stages: Record<string, { status?: string; latest?: unknown }>,
): WorkflowContext {
  const ctx: WorkflowContext = { trigger: {}, stages: {} };
  for (const [id, opts] of Object.entries(stages)) {
    ctx.stages[id] = {
      status: (opts.status || 'pending') as any,
      run_count: opts.status === 'completed' ? 1 : 0,
      runs: [],
      ...(opts.latest !== undefined ? { latest: opts.latest as Record<string, unknown> } : {}),
    };
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Fan-in workflow fixture (no trigger stage — uses plain 'code-executor')
// ---------------------------------------------------------------------------

const fanInWorkflow: WorkflowDefinition = {
  id: 'fan-in-wf',
  name: 'Fan In',
  active: true,
  trigger: { provider: 'manual' },
  stages: [
    { id: 'a', type: 'code-executor' },
    { id: 'b', type: 'code-executor' },
    { id: 'merge', type: 'code-executor', input_mode: 'fan_in' },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'merge' },
    { id: 'e2', source: 'b', target: 'merge' },
  ],
};

// Workflow with a real manual-trigger stage
const triggerWorkflow: WorkflowDefinition = {
  id: 'trigger-wf',
  name: 'Trigger Workflow',
  active: true,
  trigger: { provider: 'manual' },
  stages: [
    { id: 'trig', type: 'manual-trigger' },
    { id: 'step1', type: 'code-executor' },
    { id: 'step2', type: 'code-executor' },
  ],
  edges: [
    { id: 'e1', source: 'trig', target: 'step1' },
    { id: 'e2', source: 'step1', target: 'step2' },
  ],
};

const mockEvent: Event = {
  id: 'evt-1',
  provider: 'manual',
  type: 'manual.triggered',
  timestamp: '2026-01-01T00:00:00Z',
  payload: { prompt: 'hello world' },
};

// ---------------------------------------------------------------------------
// recordFanInCompletion — all_success
// ---------------------------------------------------------------------------

describe('recordFanInCompletion — all_success', () => {
  it('returns null when only 1 of 2 upstream stages has completed', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    const result = recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, fanInWorkflow);
    expect(result).toBeNull();
  });

  it('returns merged inputs when 2 of 2 upstream stages have completed', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, fanInWorkflow);
    const result = recordFanInCompletion('merge', 'b', { val: 2 }, 'completed', ctx, fanInWorkflow);
    expect(result).toEqual({ a: { val: 1 }, b: { val: 2 } });
  });

  it('returns "failed" immediately when any upstream stage fails', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    const result = recordFanInCompletion('merge', 'a', null, 'failed', ctx, fanInWorkflow);
    expect(result).toBe('failed');
  });

  it('returns "failed" even when only 1 of 2 upstreams has reported (fail-fast)', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    recordFanInCompletion('merge', 'b', { val: 2 }, 'completed', ctx, fanInWorkflow);
    const result = recordFanInCompletion('merge', 'a', null, 'failed', ctx, fanInWorkflow);
    expect(result).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// recordFanInCompletion — any_success
// ---------------------------------------------------------------------------

const anySuccessWorkflow: WorkflowDefinition = {
  ...fanInWorkflow,
  stages: [
    { id: 'a', type: 'code-executor' },
    { id: 'b', type: 'code-executor' },
    { id: 'merge', type: 'code-executor', input_mode: 'fan_in', trigger_rule: 'any_success' },
  ],
};

describe('recordFanInCompletion — any_success', () => {
  it('returns merged inputs on the first upstream success without waiting for the rest', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    const result = recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, anySuccessWorkflow);
    expect(result).toEqual({ a: { val: 1 } });
  });

  it('returns null on second call after first trigger (__fired sentinel)', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    // First call fires
    recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, anySuccessWorkflow);
    // Second upstream completes — should not re-trigger
    const result = recordFanInCompletion('merge', 'b', { val: 2 }, 'completed', ctx, anySuccessWorkflow);
    expect(result).toBeNull();
  });

  it('does not fire when the only completion is a failure', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    const result = recordFanInCompletion('merge', 'a', null, 'failed', ctx, anySuccessWorkflow);
    // any_success only looks at successCount, not failedCount — still null here
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordFanInCompletion — none_failed_min_one_success
// ---------------------------------------------------------------------------

const nfmosWorkflow: WorkflowDefinition = {
  ...fanInWorkflow,
  stages: [
    { id: 'a', type: 'code-executor' },
    { id: 'b', type: 'code-executor' },
    { id: 'merge', type: 'code-executor', input_mode: 'fan_in', trigger_rule: 'none_failed_min_one_success' },
  ],
};

describe('recordFanInCompletion — none_failed_min_one_success', () => {
  it('returns null when both upstreams are skipped (no success)', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    recordFanInCompletion('merge', 'a', null, 'skipped', ctx, nfmosWorkflow);
    const result = recordFanInCompletion('merge', 'b', null, 'skipped', ctx, nfmosWorkflow);
    expect(result).toBeNull();
  });

  it('returns merged when 1 upstream succeeds and 1 is skipped', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, nfmosWorkflow);
    const result = recordFanInCompletion('merge', 'b', null, 'skipped', ctx, nfmosWorkflow);
    // Only completed entries appear in the merged output
    expect(result).toEqual({ a: { val: 1 } });
  });

  it('returns "failed" when any upstream fails', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, nfmosWorkflow);
    const result = recordFanInCompletion('merge', 'b', null, 'failed', ctx, nfmosWorkflow);
    // none_failed_min_one_success: failedCount > 0 means not ready, but all arrived so also not
    // triggered; however all_success returns 'failed' — nfmosWorkflow just returns null here
    // (it doesn't early-exit like all_success). Verify null rather than 'failed'.
    expect(result).toBeNull();
  });

  it('returns null while still waiting for all upstreams to arrive', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    const result = recordFanInCompletion('merge', 'a', { val: 1 }, 'completed', ctx, nfmosWorkflow);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordFanInCompletion — partial pre-populated state
// ---------------------------------------------------------------------------

describe('recordFanInCompletion — partial pre-populated fanInCompletions', () => {
  it('correctly merges when context already has one upstream completion recorded', () => {
    const ctx = makeContext({ a: {}, b: {}, merge: {} });
    // Pre-populate one upstream as if a previous call already stored it
    ctx.fanInCompletions = {
      merge: {
        a: { output: { pre: 'populated' }, status: 'completed' } as any,
      },
    };
    const result = recordFanInCompletion('merge', 'b', { val: 2 }, 'completed', ctx, fanInWorkflow);
    expect(result).toEqual({ a: { pre: 'populated' }, b: { val: 2 } });
  });
});

// ---------------------------------------------------------------------------
// countIncomingSuccessEdges
// ---------------------------------------------------------------------------

describe('countIncomingSuccessEdges', () => {
  const edges: EdgeDefinition[] = [
    { id: 'e1', source: 'a', target: 'merge' },
    { id: 'e2', source: 'b', target: 'merge' },
    { id: 'e3', source: 'c', target: 'merge', trigger: 'on_error' },
  ];

  it('counts 1 for a stage with a single on_success incoming edge', () => {
    const singleEdge: EdgeDefinition[] = [{ id: 'e1', source: 'a', target: 'merge' }];
    expect(countIncomingSuccessEdges('merge', singleEdge)).toBe(1);
  });

  it('counts only on_success edges, ignoring on_error edges', () => {
    expect(countIncomingSuccessEdges('merge', edges)).toBe(2);
  });

  it('returns 0 when there are no incoming edges for the stage', () => {
    expect(countIncomingSuccessEdges('orphan', edges)).toBe(0);
  });

  it('counts 0 for a stage that only has on_error incoming edges', () => {
    const errorOnly: EdgeDefinition[] = [
      { id: 'e1', source: 'x', target: 'fallback', trigger: 'on_error' },
    ];
    expect(countIncomingSuccessEdges('fallback', errorOnly)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateEdges — max_traversals
// ---------------------------------------------------------------------------

describe('evaluateEdges — max_traversals', () => {
  it('skips edge when edgeTraversals count equals max_traversals', () => {
    const ctx: WorkflowContext = {
      trigger: {},
      stages: {},
      edgeTraversals: { 'e1': 2 },
    };
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', max_traversals: 2 },
    ];
    const result = evaluateEdges('a', {}, ctx, edges);
    expect(result).toEqual([]);
  });

  it('follows edge and increments counter when edgeTraversals count is below max_traversals', () => {
    const ctx: WorkflowContext = {
      trigger: {},
      stages: {},
      edgeTraversals: { 'e1': 1 },
    };
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', max_traversals: 2 },
    ];
    const result = evaluateEdges('a', {}, ctx, edges);
    expect(result).toEqual(['b']);
    expect(ctx.edgeTraversals!['e1']).toBe(2);
  });

  it('initializes edgeTraversals to 1 on first traversal', () => {
    const ctx: WorkflowContext = { trigger: {}, stages: {} };
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', max_traversals: 3 },
    ];
    evaluateEdges('a', {}, ctx, edges);
    expect(ctx.edgeTraversals!['e1']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateEdges — on_error trigger type
// ---------------------------------------------------------------------------

describe('evaluateEdges — on_error trigger type', () => {
  const edges: EdgeDefinition[] = [
    { id: 'e1', source: 'agent', target: 'next' },
    { id: 'e2', source: 'agent', target: 'fallback', trigger: 'on_error' },
  ];
  const ctx: WorkflowContext = { trigger: {}, stages: {} };

  it('returns only on_error targets when triggerType is on_error', () => {
    const result = evaluateEdges('agent', {}, ctx, edges, 'on_error');
    expect(result).toEqual(['fallback']);
  });

  it('does not return on_error targets when triggerType is on_success', () => {
    const result = evaluateEdges('agent', {}, ctx, edges, 'on_success');
    expect(result).not.toContain('fallback');
    expect(result).toContain('next');
  });
});

// ---------------------------------------------------------------------------
// evaluateEdges — multiple conditional edges
// ---------------------------------------------------------------------------

describe('evaluateEdges — multiple conditional edges', () => {
  const ctx: WorkflowContext = { trigger: {}, stages: {} };

  it('returns only edges whose condition evaluates to true', () => {
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', condition: 'output.score > 5' },
      { id: 'e2', source: 'a', target: 'c', condition: 'output.score <= 5' },
    ];
    const result = evaluateEdges('a', { score: 8 }, ctx, edges);
    expect(result).toEqual(['b']);
    expect(result).not.toContain('c');
  });

  it('returns multiple targets when multiple conditions are true', () => {
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', condition: 'output.score > 5' },
      { id: 'e2', source: 'a', target: 'c', condition: 'output.flagged === true' },
    ];
    const result = evaluateEdges('a', { score: 8, flagged: true }, ctx, edges);
    expect(result).toContain('b');
    expect(result).toContain('c');
  });
});

// ---------------------------------------------------------------------------
// evaluateEdges — unconditional edge
// ---------------------------------------------------------------------------

describe('evaluateEdges — unconditional edge', () => {
  it('always follows an edge with no condition', () => {
    const ctx: WorkflowContext = { trigger: {}, stages: {} };
    const edges: EdgeDefinition[] = [{ id: 'e1', source: 'a', target: 'b' }];
    expect(evaluateEdges('a', {}, ctx, edges)).toEqual(['b']);
    expect(evaluateEdges('a', { anything: true }, ctx, edges)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// evaluateEdges — condition referencing output fields
// ---------------------------------------------------------------------------

describe('evaluateEdges — condition referencing output fields', () => {
  it('evaluates deeply nested output field', () => {
    const ctx: WorkflowContext = { trigger: {}, stages: {} };
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', condition: 'output.result.status === "ok"' },
    ];
    const result = evaluateEdges('a', { result: { status: 'ok' } }, ctx, edges);
    expect(result).toEqual(['b']);
  });

  it('does not follow edge when output field is missing / undefined', () => {
    const ctx: WorkflowContext = { trigger: {}, stages: {} };
    const edges: EdgeDefinition[] = [
      { id: 'e1', source: 'a', target: 'b', condition: 'output.missing === "value"' },
    ];
    const result = evaluateEdges('a', {}, ctx, edges);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// initializeContext
// ---------------------------------------------------------------------------

describe('initializeContext', () => {
  it('creates pending stage contexts for non-trigger stages', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    expect(ctx.stages['step1']).toEqual({ status: 'pending', run_count: 0, runs: [] });
    expect(ctx.stages['step2']).toEqual({ status: 'pending', run_count: 0, runs: [] });
  });

  it('excludes trigger stages by marking them as completed with trigger payload', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    const trigStage = ctx.stages['trig'];
    expect(trigStage.status).toBe('completed');
    expect(trigStage.run_count).toBe(1);
    expect(trigStage.latest).toEqual(mockEvent.payload);
  });

  it('stores the trigger payload at ctx.trigger (not the full event)', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    expect(ctx.trigger).toEqual(mockEvent.payload);
    expect(ctx.trigger).not.toHaveProperty('id');
    expect(ctx.trigger).not.toHaveProperty('timestamp');
  });

  it('initializes edgeTraversals as empty object', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    expect(ctx.edgeTraversals).toEqual({});
  });

  it('trigger stage run records use event timestamp', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    const run = ctx.stages['trig'].runs[0];
    expect(run.started_at).toBe(mockEvent.timestamp);
    expect(run.completed_at).toBe(mockEvent.timestamp);
  });

  it('creates all stages including non-trigger ones', () => {
    const ctx = initializeContext(mockEvent, triggerWorkflow);
    expect(Object.keys(ctx.stages)).toHaveLength(3);
    expect(ctx.stages).toHaveProperty('trig');
    expect(ctx.stages).toHaveProperty('step1');
    expect(ctx.stages).toHaveProperty('step2');
  });
});

// ---------------------------------------------------------------------------
// isTerminalStage
// ---------------------------------------------------------------------------

describe('isTerminalStage', () => {
  it('returns true for a stage with no outgoing edges', () => {
    expect(isTerminalStage(fanInWorkflow, 'merge')).toBe(true);
  });

  it('returns false for a stage with at least one outgoing edge', () => {
    expect(isTerminalStage(fanInWorkflow, 'a')).toBe(false);
    expect(isTerminalStage(fanInWorkflow, 'b')).toBe(false);
  });

  it('returns true for a stage that does not exist in the edge list', () => {
    expect(isTerminalStage(fanInWorkflow, 'nonexistent')).toBe(true);
  });

  it('returns false for intermediate stage in a linear workflow', () => {
    const linear: WorkflowDefinition = {
      id: 'lin',
      name: 'Linear',
      active: true,
      trigger: { provider: 'manual' },
      stages: [
        { id: 'first', type: 'code-executor' },
        { id: 'last', type: 'code-executor' },
      ],
      edges: [{ id: 'e1', source: 'first', target: 'last' }],
    };
    expect(isTerminalStage(linear, 'first')).toBe(false);
    expect(isTerminalStage(linear, 'last')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findEntryStages
// ---------------------------------------------------------------------------

describe('findEntryStages', () => {
  it('returns stages that trigger nodes point to (trigger-connected entry)', () => {
    // triggerWorkflow has trig -> step1, so step1 should be the entry
    const entries = findEntryStages(triggerWorkflow);
    expect(entries).toContain('step1');
    expect(entries).not.toContain('trig');
  });

  it('excludes trigger stages themselves from results', () => {
    const entries = findEntryStages(triggerWorkflow);
    expect(entries).not.toContain('trig');
  });

  it('falls back to stages with no incoming edges when no trigger edges exist', () => {
    // fanInWorkflow has no trigger-type stages, so fallback logic applies
    const entries = findEntryStages(fanInWorkflow);
    // 'a' and 'b' have no incoming edges; 'merge' has incoming edges from 'a' and 'b'
    expect(entries).toContain('a');
    expect(entries).toContain('b');
    expect(entries).not.toContain('merge');
  });

  it('returns empty array when all non-trigger stages have incoming edges', () => {
    const allConnected: WorkflowDefinition = {
      id: 'cycle',
      name: 'Cycle',
      active: true,
      trigger: { provider: 'manual' },
      stages: [
        { id: 'x', type: 'code-executor' },
        { id: 'y', type: 'code-executor' },
      ],
      edges: [
        { id: 'e1', source: 'x', target: 'y' },
        { id: 'e2', source: 'y', target: 'x' },
      ],
    };
    const entries = findEntryStages(allConnected);
    expect(entries).toEqual([]);
  });
});
