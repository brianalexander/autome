import { describe, it, expect } from 'vitest';
import { initializeContext, findEntryStages, evaluateEdges, isTerminalStage } from '../pipeline-workflow.js';
import type { WorkflowDefinition } from '../../types/workflow.js';
import type { Event } from '../../types/events.js';

// --- Shared fixtures ---

const mockEvent: Event = {
  id: 'evt-1',
  provider: 'github',
  type: 'pull_request.opened',
  timestamp: '2026-01-01T00:00:00Z',
  payload: { pr: 42, title: 'fix: bug' },
};

// Linear workflow: coder -> reviewer
const linearWorkflow: WorkflowDefinition = {
  id: 'pipe-linear',
  name: 'Linear Workflow',
  active: true,
  trigger: { provider: 'github' },
  stages: [
    { id: 'coder', type: 'agent' },
    { id: 'reviewer', type: 'agent' },
  ],
  edges: [
    {
      id: 'e1',
      source: 'coder',
      target: 'reviewer',
      prompt_template: '{{ output }}',
    },
  ],
};

// Code-gen/reviewer cycle: coder <-> reviewer cycle, reviewer can also exit to done
const cycleWorkflow: WorkflowDefinition = {
  id: 'pipe-cycle',
  name: 'Cycle Workflow',
  active: true,
  trigger: { provider: 'github' },
  stages: [
    { id: 'coder', type: 'agent', config: { agentId: 'coder', max_iterations: 3 } },
    { id: 'reviewer', type: 'agent' },
    { id: 'done', type: 'gate', config: { type: 'auto' } },
  ],
  edges: [
    {
      id: 'e1',
      source: 'coder',
      target: 'reviewer',
      prompt_template: '{{ output }}',
    },
    {
      id: 'e2',
      source: 'reviewer',
      target: 'coder',
      condition: `output.decision === 'revise'`,
      prompt_template: '{{ output }}',
    },
    { id: 'e3', source: 'reviewer', target: 'done', condition: `output.decision === 'approved'` },
  ],
};

// Fan-out workflow: start -> [branch-a, branch-b]
const fanOutWorkflow: WorkflowDefinition = {
  id: 'pipe-fanout',
  name: 'Fan-Out Workflow',
  active: true,
  trigger: { provider: 'github' },
  stages: [
    { id: 'start', type: 'agent' },
    { id: 'branch-a', type: 'agent' },
    { id: 'branch-b', type: 'agent' },
  ],
  edges: [
    {
      id: 'e1',
      source: 'start',
      target: 'branch-a',
      prompt_template: '{{ output }}',
    },
    {
      id: 'e2',
      source: 'start',
      target: 'branch-b',
      prompt_template: '{{ output }}',
    },
  ],
};

// Circular workflow: a -> b -> a (all stages have incoming edges)
const circularWorkflow: WorkflowDefinition = {
  id: 'pipe-circular',
  name: 'Circular Workflow',
  active: true,
  trigger: { provider: 'test' },
  stages: [
    { id: 'a', type: 'agent' },
    { id: 'b', type: 'agent' },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', prompt_template: '{{ output }}' },
    { id: 'e2', source: 'b', target: 'a', prompt_template: '{{ output }}' },
  ],
};

// --- initializeContext ---

describe('initializeContext', () => {
  it('creates correct structure with all stages set to pending', () => {
    const ctx = initializeContext(mockEvent, linearWorkflow);

    expect(ctx.trigger).toEqual(mockEvent.payload);
    expect(Object.keys(ctx.stages)).toEqual(['coder', 'reviewer']);
    expect(ctx.stages['coder']).toEqual({ status: 'pending', run_count: 0, runs: [] });
    expect(ctx.stages['reviewer']).toEqual({ status: 'pending', run_count: 0, runs: [] });
  });

  it('sets trigger to the event payload, not the full event', () => {
    const ctx = initializeContext(mockEvent, linearWorkflow);
    expect(ctx.trigger).toEqual({ pr: 42, title: 'fix: bug' });
    expect(ctx.trigger).not.toHaveProperty('id');
  });

  it('initializes all stages even when workflow has many stages', () => {
    const ctx = initializeContext(mockEvent, cycleWorkflow);
    expect(Object.keys(ctx.stages)).toHaveLength(3);
    for (const stage of cycleWorkflow.stages) {
      expect(ctx.stages[stage.id].status).toBe('pending');
      expect(ctx.stages[stage.id].run_count).toBe(0);
      expect(ctx.stages[stage.id].runs).toEqual([]);
    }
  });
});

// --- findEntryStages ---

describe('findEntryStages', () => {
  it('finds stages with no incoming edges', () => {
    const entries = findEntryStages(linearWorkflow);
    expect(entries).toEqual(['coder']);
  });

  it('finds multiple entry stages in a fan-out workflow', () => {
    const entries = findEntryStages(fanOutWorkflow);
    expect(entries).toEqual(['start']);
  });

  it('returns empty array for cycle workflow where every stage has an incoming edge', () => {
    // coder has an incoming edge from reviewer (e2: reviewer->coder), so no true entry stage
    const entries = findEntryStages(cycleWorkflow);
    expect(entries).toEqual([]);
  });

  it('returns empty array when all stages have incoming edges (circular graph)', () => {
    const entries = findEntryStages(circularWorkflow);
    expect(entries).toEqual([]);
  });
});

// --- evaluateEdges ---

describe('evaluateEdges', () => {
  const emptyContext = { trigger: {}, stages: {} };

  it('unconditional edges always match', () => {
    const edges = [{ id: 'e1', source: 'coder', target: 'reviewer' }] as any;
    const result = evaluateEdges('coder', {}, emptyContext, edges);
    expect(result).toEqual(['reviewer']);
  });

  it('conditional edge evaluates to true when condition matches output', () => {
    const output = { decision: 'approved' };
    const result = evaluateEdges('reviewer', output, emptyContext, cycleWorkflow.edges);
    expect(result).toContain('done');
    expect(result).not.toContain('coder');
  });

  it('conditional edge evaluates to false when condition does not match', () => {
    const output = { decision: 'revise' };
    const result = evaluateEdges('reviewer', output, emptyContext, cycleWorkflow.edges);
    expect(result).toContain('coder');
    expect(result).not.toContain('done');
  });

  it('multiple matching edges produces fan-out', () => {
    const edges = [
      { id: 'e1', source: 'start', target: 'branch-a' },
      { id: 'e2', source: 'start', target: 'branch-b' },
    ] as any;
    const result = evaluateEdges('start', {}, emptyContext, edges);
    expect(result).toEqual(['branch-a', 'branch-b']);
  });

  it('no matching conditional edges returns empty array (for skip propagation)', () => {
    const output = { decision: 'unknown-value' };
    const result = evaluateEdges('reviewer', output, emptyContext, cycleWorkflow.edges);
    expect(result).toEqual([]);
  });

  it('terminal stage (no outgoing edges) returns empty array', () => {
    const result = evaluateEdges('reviewer', {}, emptyContext, linearWorkflow.edges);
    expect(result).toEqual([]);
  });

  it('can detect cycle edges — edge target equals the stage itself', () => {
    const edges = [{ id: 'e1', source: 'coder', target: 'coder' }] as any;
    const result = evaluateEdges('coder', {}, emptyContext, edges);
    expect(result).toEqual(['coder']);
  });

  it('evaluates conditions with context — context.stages run_count comparison', () => {
    const contextWithRuns = {
      trigger: {},
      stages: {
        coder: { status: 'completed' as const, run_count: 2, runs: [] },
      },
    };
    const edges = [
      { id: 'e1', source: 'coder', target: 'reviewer', condition: `context.stages['coder'].run_count < 3` },
      { id: 'e2', source: 'coder', target: 'done', condition: `context.stages['coder'].run_count >= 3` },
    ] as any;
    const result = evaluateEdges('coder', {}, contextWithRuns, edges);
    expect(result).toEqual(['reviewer']);
  });

  it('evaluates context condition when run_count meets threshold', () => {
    const contextWithRuns = {
      trigger: {},
      stages: {
        coder: { status: 'completed' as const, run_count: 3, runs: [] },
      },
    };
    const edges = [
      { id: 'e1', source: 'coder', target: 'reviewer', condition: `context.stages['coder'].run_count < 3` },
      { id: 'e2', source: 'coder', target: 'done', condition: `context.stages['coder'].run_count >= 3` },
    ] as any;
    const result = evaluateEdges('coder', {}, contextWithRuns, edges);
    expect(result).toEqual(['done']);
  });
});

// --- isTerminalStage ---

describe('isTerminalStage', () => {
  it('returns true for stage with no outgoing edges', () => {
    expect(isTerminalStage(linearWorkflow, 'reviewer')).toBe(true);
  });

  it('returns false for stage with outgoing edges', () => {
    expect(isTerminalStage(linearWorkflow, 'coder')).toBe(false);
  });

  it('returns true for done stage in cycle workflow', () => {
    expect(isTerminalStage(cycleWorkflow, 'done')).toBe(true);
  });

  it('returns false for intermediate stages in cycle workflow', () => {
    expect(isTerminalStage(cycleWorkflow, 'coder')).toBe(false);
    expect(isTerminalStage(cycleWorkflow, 'reviewer')).toBe(false);
  });
});

// --- evaluateEdges: edge trigger type filtering ---

describe('evaluateEdges with edge trigger types', () => {
  const emptyContext = { trigger: {}, stages: {} };
  const edgesWithErrorEdge = [
    { id: 'e1', source: 'agent', target: 'next', condition: undefined },
    { id: 'e2', source: 'agent', target: 'fallback', trigger: 'on_error' as const },
  ] as any;

  it('on_success edges are returned by default (triggerType=on_success)', () => {
    const result = evaluateEdges('agent', { data: 1 }, emptyContext, edgesWithErrorEdge, 'on_success');
    expect(result).toEqual(['next']);
  });

  it('on_error edges are returned when triggerType=on_error', () => {
    const result = evaluateEdges('agent', { error: 'fail' }, emptyContext, edgesWithErrorEdge, 'on_error');
    expect(result).toEqual(['fallback']);
  });

  it('on_error edges are not returned when triggerType=on_success', () => {
    const result = evaluateEdges('agent', {}, emptyContext, edgesWithErrorEdge, 'on_success');
    expect(result).not.toContain('fallback');
  });

  it('default triggerType is on_success', () => {
    const result = evaluateEdges('agent', {}, emptyContext, edgesWithErrorEdge);
    expect(result).toEqual(['next']);
  });
});

// --- evaluateEdges: mixed conditional + error edges ---

describe('evaluateEdges with conditional error edges', () => {
  const emptyContext = { trigger: {}, stages: {} };
  const edges = [
    { id: 'e1', source: 'a', target: 'b', condition: 'output.ok === true' },
    { id: 'e2', source: 'a', target: 'error-handler', trigger: 'on_error' as const },
  ] as any;

  it('conditional success edge matches when condition is true', () => {
    const result = evaluateEdges('a', { ok: true }, emptyContext, edges, 'on_success');
    expect(result).toEqual(['b']);
  });

  it('conditional success edge does not match when condition is false', () => {
    const result = evaluateEdges('a', { ok: false }, emptyContext, edges, 'on_success');
    expect(result).toEqual([]);
  });

  it('error edge still available regardless of success conditions', () => {
    const result = evaluateEdges('a', { error: 'boom' }, emptyContext, edges, 'on_error');
    expect(result).toEqual(['error-handler']);
  });
});
