/**
 * Tests for deadlock cycle detection in validateGraphStructure.
 *
 * A deadlock occurs when a fan_in node has an incoming edge that is a
 * "cycle-back" edge — meaning the edge source is reachable downstream from
 * the fan_in node. In that scenario the fan_in node waits for all inputs,
 * but the cycle-back source only fires after the fan_in completes, causing
 * a permanent stall.
 *
 * Note: validateGraphStructure calls nodeRegistry.isTriggerType() to
 * identify triggers. We register the minimal set of node types needed
 * before running these tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { nodeRegistry } from '../../nodes/registry.js';
import { allBuiltinSpecs } from '../../nodes/builtin/index.js';
import { validateGraphStructure } from '../routes/validation.js';

beforeAll(() => {
  // Register built-in specs so isTriggerType() recognises 'manual-trigger'
  for (const spec of allBuiltinSpecs) {
    try {
      nodeRegistry.register(spec);
    } catch {
      // Already registered from a prior test file — safe to ignore
    }
  }
});

describe('deadlock cycle detection', () => {
  it('fan_in node with cycle-back edge produces an error', () => {
    const stages = [
      { id: 'trigger', type: 'manual-trigger' },
      { id: 'fetch', type: 'code-executor' },
      { id: 'filter', type: 'code-executor', input_mode: 'fan_in' },
      { id: 'reviewer', type: 'agent' },
      { id: 'aggregator', type: 'code-executor' },
    ];
    const edges = [
      { source: 'trigger', target: 'fetch' },
      { source: 'trigger', target: 'filter' },
      { source: 'fetch', target: 'filter' },
      { source: 'filter', target: 'reviewer' },
      { source: 'reviewer', target: 'aggregator' },
      { source: 'aggregator', target: 'filter' }, // cycle-back to fan_in node
    ];

    const result = validateGraphStructure(stages, edges);

    expect(result.errors.some((e) => /deadlock|fan_in|cycle/i.test(e))).toBe(true);
  });

  it('fan_in node with NO cycle-back edge is valid', () => {
    const stages = [
      { id: 'trigger', type: 'manual-trigger' },
      { id: 'a', type: 'code-executor' },
      { id: 'b', type: 'code-executor' },
      { id: 'merge', type: 'code-executor', input_mode: 'fan_in' },
    ];
    const edges = [
      { source: 'trigger', target: 'a' },
      { source: 'trigger', target: 'b' },
      { source: 'a', target: 'merge' },
      { source: 'b', target: 'merge' },
    ];

    const result = validateGraphStructure(stages, edges);

    expect(result.errors.filter((e) => /deadlock|fan_in|cycle/i.test(e))).toHaveLength(0);
  });

  it('fan_in where ALL inputs are cycle-back is valid (all re-fire together)', () => {
    // Pattern: filter → reviewerA → aggregator (fan_in)
    //          filter → reviewerB → aggregator (fan_in)
    //          aggregator → decision → filter (cycle-back)
    // The aggregator can reach both reviewers via the cycle, but since ALL
    // its inputs are inside the cycle, they all re-fire on every iteration.
    const stages = [
      { id: 'trigger', type: 'manual-trigger' },
      { id: 'filter', type: 'code-executor' },
      { id: 'reviewer_a', type: 'agent' },
      { id: 'reviewer_b', type: 'agent' },
      { id: 'aggregator', type: 'code-executor', input_mode: 'fan_in' },
      { id: 'decision', type: 'code-executor' },
    ];
    const edges = [
      { source: 'trigger', target: 'filter' },
      { source: 'filter', target: 'reviewer_a' },
      { source: 'filter', target: 'reviewer_b' },
      { source: 'reviewer_a', target: 'aggregator' },
      { source: 'reviewer_b', target: 'aggregator' },
      { source: 'aggregator', target: 'decision' },
      { source: 'decision', target: 'filter' }, // cycle-back
    ];

    const result = validateGraphStructure(stages, edges);

    expect(result.errors.filter((e) => /deadlock|fan_in|cycle/i.test(e))).toHaveLength(0);
  });

  it('non-fan_in node with cycle-back edge does not produce a deadlock error', () => {
    // A queue-mode (default) node accumulates inputs one at a time,
    // so a cycle-back is fine — it just queues another execution.
    const stages = [
      { id: 'trigger', type: 'manual-trigger' },
      { id: 'worker', type: 'code-executor' }, // default — no input_mode
      { id: 'reviewer', type: 'agent' },
    ];
    const edges = [
      { source: 'trigger', target: 'worker' },
      { source: 'worker', target: 'reviewer' },
      { source: 'reviewer', target: 'worker' }, // cycle-back, but queue mode — OK
    ];

    const result = validateGraphStructure(stages, edges);

    expect(result.errors.filter((e) => /deadlock|fan_in|cycle/i.test(e))).toHaveLength(0);
  });
});
