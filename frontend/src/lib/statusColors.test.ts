import { describe, it, expect } from 'vitest';
import { getStatusCardClasses, getStageBorderClass, getTimelineDotClasses } from './statusColors';

// ---------------------------------------------------------------------------
// getStatusCardClasses
// ---------------------------------------------------------------------------
describe('getStatusCardClasses', () => {
  it('returns green classes for "completed"', () => {
    const result = getStatusCardClasses('completed');
    expect(result).toContain('border-green-300');
    expect(result).toContain('bg-status-success-muted');
  });

  it('returns red classes for "failed"', () => {
    const result = getStatusCardClasses('failed');
    expect(result).toContain('border-red-300');
    expect(result).toContain('bg-status-error-muted');
  });

  it('returns blue classes for "running" (default)', () => {
    const result = getStatusCardClasses('running');
    expect(result).toContain('border-blue-300');
    expect(result).toContain('bg-status-info-muted');
  });

  it('returns blue classes for unknown status', () => {
    const result = getStatusCardClasses('pending');
    expect(result).toContain('border-blue-300');
    expect(result).toContain('bg-status-info-muted');
  });

  it('returns blue classes for empty string', () => {
    const result = getStatusCardClasses('');
    expect(result).toContain('border-blue-300');
  });
});

// ---------------------------------------------------------------------------
// getStageBorderClass
// ---------------------------------------------------------------------------
describe('getStageBorderClass', () => {
  it('returns green border for "completed"', () => {
    expect(getStageBorderClass('completed')).toContain('border-green-300');
  });

  it('returns red border for "failed"', () => {
    expect(getStageBorderClass('failed')).toContain('border-red-300');
  });

  it('returns blue border for "running"', () => {
    expect(getStageBorderClass('running')).toContain('border-blue-300');
  });

  it('returns generic border for unknown status', () => {
    expect(getStageBorderClass('pending')).toBe('border-border');
  });

  it('returns generic border for empty string', () => {
    expect(getStageBorderClass('')).toBe('border-border');
  });

  it('returns the exact border-border value for unmapped statuses', () => {
    // Verify the default doesn't accidentally include a color class
    const result = getStageBorderClass('skipped');
    expect(result).not.toContain('green');
    expect(result).not.toContain('red');
    expect(result).not.toContain('blue');
  });
});

// ---------------------------------------------------------------------------
// getTimelineDotClasses
// ---------------------------------------------------------------------------
describe('getTimelineDotClasses', () => {
  it('returns green dot and line for "completed"', () => {
    const { dot, line } = getTimelineDotClasses('completed');
    expect(dot).toContain('border-green-500');
    expect(dot).toContain('bg-green-500');
    expect(line).toContain('bg-green-300');
  });

  it('returns red dot and line for "failed"', () => {
    const { dot, line } = getTimelineDotClasses('failed');
    expect(dot).toContain('border-red-500');
    expect(dot).toContain('bg-red-500');
    expect(line).toContain('bg-red-300');
  });

  it('returns blue dot and line for "running" (default)', () => {
    const { dot, line } = getTimelineDotClasses('running');
    expect(dot).toContain('border-blue-500');
    expect(dot).toContain('bg-blue-500');
    expect(line).toContain('bg-blue-300');
  });

  it('returns blue dot and line for unknown status', () => {
    const { dot, line } = getTimelineDotClasses('pending');
    expect(dot).toContain('border-blue-500');
    expect(line).toContain('bg-blue-300');
  });

  it('returns an object with both dot and line keys', () => {
    const result = getTimelineDotClasses('completed');
    expect(result).toHaveProperty('dot');
    expect(result).toHaveProperty('line');
  });

  it('returns blue classes for empty string input', () => {
    const { dot } = getTimelineDotClasses('');
    expect(dot).toContain('blue');
  });
});
