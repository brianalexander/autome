/**
 * Tests for max_iterations semantics in resolveMaxIterations.
 *
 * Covers:
 * - An explicit numeric value is used as the cap.
 * - undefined → Infinity (no cap, as described in the config schema).
 * - null → Infinity (treats null the same as unset).
 * - 0 → 0 (zero means the stage can run 0 additional times through the cycle;
 *   iteration 1 would be > 0 so the first iteration would be blocked).
 */

import { describe, it, expect } from 'vitest';
import { resolveMaxIterations } from '../stage-executor.js';

describe('resolveMaxIterations', () => {
  it('uses the explicit numeric value when set', () => {
    expect(resolveMaxIterations(5)).toBe(5);
  });

  it('iteration 5 is allowed and iteration 6 is blocked when max_iterations === 5', () => {
    const max = resolveMaxIterations(5);
    // The check in executeStepWithLifecycle is: if (iteration > maxIterations) throw
    expect(5 > max).toBe(false); // iteration 5 allowed
    expect(6 > max).toBe(true);  // iteration 6 blocked
  });

  it('returns Infinity when max_iterations is undefined (no cap)', () => {
    expect(resolveMaxIterations(undefined)).toBe(Infinity);
  });

  it('iteration 1000 is allowed when max_iterations is undefined', () => {
    const max = resolveMaxIterations(undefined);
    expect(1000 > max).toBe(false);
  });

  it('returns Infinity when max_iterations is null (treats null as unset)', () => {
    expect(resolveMaxIterations(null)).toBe(Infinity);
  });

  it('returns 0 when max_iterations is 0', () => {
    const max = resolveMaxIterations(0);
    expect(max).toBe(0);
    // iteration 1 would exceed 0, so the cycle body never runs
    expect(1 > max).toBe(true);
  });

  it('uses large explicit values as-is', () => {
    expect(resolveMaxIterations(100)).toBe(100);
  });
});
