/**
 * Tests for safeEval and safeEvalCondition.
 *
 * safeEval runs expressions in a restricted vm sandbox — no access to
 * process, require, global, or other Node.js globals.
 * safeEvalCondition wraps safeEval and returns false on any error.
 */
import { describe, it, expect, vi } from 'vitest';
import { safeEval, safeEvalCondition } from '../safe-eval.js';

// ---------------------------------------------------------------------------
// safeEval — raw evaluation, throws on error
// ---------------------------------------------------------------------------

describe('safeEval', () => {
  it('evaluates a simple boolean literal', () => {
    expect(safeEval('true', {})).toBe(true);
  });

  it('evaluates a simple numeric comparison', () => {
    expect(safeEval('output.score > 5', { output: { score: 10 } })).toBe(true);
    expect(safeEval('output.score > 5', { output: { score: 3 } })).toBe(false);
  });

  it('evaluates a string equality check', () => {
    expect(safeEval("output.status === 'approved'", { output: { status: 'approved' } })).toBe(true);
    expect(safeEval("output.status === 'approved'", { output: { status: 'rejected' } })).toBe(false);
  });

  it('evaluates nested property access', () => {
    expect(safeEval('output.result.pass === true', { output: { result: { pass: true } } })).toBe(true);
    expect(safeEval('output.result.pass === true', { output: { result: { pass: false } } })).toBe(false);
  });

  it('evaluates array length access', () => {
    expect(safeEval('output.items.length > 0', { output: { items: ['a', 'b'] } })).toBe(true);
    expect(safeEval('output.items.length > 0', { output: { items: [] } })).toBe(false);
  });

  it('evaluates logical AND operator', () => {
    expect(safeEval('output.a && output.b', { output: { a: true, b: true } })).toBe(true);
    expect(safeEval('output.a && output.b', { output: { a: true, b: false } })).toBe(false);
  });

  it('evaluates negation operator', () => {
    expect(safeEval('!output.rejected', { output: { rejected: false } })).toBe(true);
    expect(safeEval('!output.rejected', { output: { rejected: true } })).toBe(false);
  });

  it('denies access to process — throws in vm context', () => {
    // process is not in the sandbox, so accessing it throws ReferenceError
    expect(() => safeEval('process.env', {})).toThrow();
  });

  it('denies access to require — throws in vm context', () => {
    expect(() => safeEval('require("fs")', {})).toThrow();
  });

  it('throws (or times out) on an infinite loop', () => {
    // The vm timeout should fire and throw an error
    expect(() => safeEval('while(true){}', {}, { timeout: 100 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// safeEvalCondition — wraps safeEval, always returns a boolean
// ---------------------------------------------------------------------------

describe('safeEvalCondition', () => {
  it('returns true for a truthy expression', () => {
    expect(safeEvalCondition('true', {})).toBe(true);
  });

  it('returns false for a falsy expression', () => {
    expect(safeEvalCondition('false', {})).toBe(false);
  });

  it('evaluates numeric comparison and returns boolean', () => {
    expect(safeEvalCondition('output.score > 5', { output: { score: 10 } })).toBe(true);
  });

  it('evaluates string comparison', () => {
    expect(safeEvalCondition("output.status === 'approved'", { output: { status: 'approved' } })).toBe(true);
  });

  it('evaluates nested property access', () => {
    expect(safeEvalCondition('output.result.pass === true', { output: { result: { pass: true } } })).toBe(true);
  });

  it('returns false (not throw) when accessing undefined nested field', () => {
    // output.missing is undefined; .field access on undefined normally throws TypeError
    // safeEvalCondition must catch this and return false
    expect(safeEvalCondition('output.missing.field', { output: {} })).toBe(false);
  });

  it('returns false (not throw) when accessing process', () => {
    expect(safeEvalCondition('process.env', {})).toBe(false);
  });

  it('returns undefined/false when accessing context.stages — context is not provided by the narrowed scope', () => {
    // The narrowed scope passes { input, trigger } or { output, trigger } — never raw `context`.
    // Accessing `context` in the sandbox should return undefined (no variable defined).
    expect(safeEvalCondition('typeof context === "undefined"', {})).toBe(true);
    expect(safeEvalCondition('context?.stages?.review?.latest?.approved', {})).toBe(false);
  });

  it('returns false (not throw) when accessing require', () => {
    expect(safeEvalCondition('require("fs")', {})).toBe(false);
  });

  it('returns false (not throw) on infinite loop', () => {
    expect(safeEvalCondition('while(true){}', {})).toBe(false);
  });

  it('returns false for an empty string expression', () => {
    // Empty string wrapped as () evaluates to undefined → falsy
    expect(safeEvalCondition('', {})).toBe(false);
  });

  it('returns false for null/undefined-ish expression (just null keyword)', () => {
    expect(safeEvalCondition('null', {})).toBe(false);
  });

  it('logs a warning when expression evaluation fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeEvalCondition('process.exit(1)', {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[safeEvalCondition]'));
    warnSpy.mockRestore();
  });

  it('coerces truthy non-boolean to true', () => {
    // Numeric expression — !! converts to boolean
    expect(safeEvalCondition('output.count', { output: { count: 5 } })).toBe(true);
    expect(safeEvalCondition('output.count', { output: { count: 0 } })).toBe(false);
  });
});
