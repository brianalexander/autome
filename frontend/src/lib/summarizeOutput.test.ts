import { describe, it, expect } from 'vitest';
import { summarizeOutput } from './summarizeOutput';

describe('summarizeOutput', () => {
  it('returns a string value directly (no key prefix)', () => {
    expect(summarizeOutput({ response: 'A quiet morning in the park.' })).toBe(
      'A quiet morning in the park.',
    );
  });

  it('returns a plain string value truncated to 100 chars', () => {
    const long = 'x'.repeat(200);
    expect(summarizeOutput(long)).toHaveLength(100);
  });

  it('prefers the "summary" magic key', () => {
    expect(summarizeOutput({ summary: 'Done', response: 'Other' })).toBe('Done');
  });

  it('uses "decision" magic key with prefix when no summary key', () => {
    expect(summarizeOutput({ decision: 'approved' })).toBe('Decision: approved');
  });

  it('prefers the "message" magic key', () => {
    expect(summarizeOutput({ message: 'Hello world', response: 'ignored' })).toBe('Hello world');
  });

  it('falls through to first string-valued field when no magic keys match', () => {
    expect(summarizeOutput({ response: 'Some text here.' })).toBe('Some text here.');
  });

  it('stringifies a non-string first value when no string fields exist', () => {
    expect(summarizeOutput({ count: 42, items: [1, 2, 3] })).toBe('42');
  });

  it('returns empty string for an empty object', () => {
    expect(summarizeOutput({})).toBe('');
  });

  it('truncates long string field values to 100 chars', () => {
    const long = 'a'.repeat(200);
    expect(summarizeOutput({ response: long })).toHaveLength(100);
  });

  it('handles a null input gracefully', () => {
    expect(summarizeOutput(null)).toBe('null');
  });

  it('handles a number input', () => {
    expect(summarizeOutput(7)).toBe('7');
  });
});
