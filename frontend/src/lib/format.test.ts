import { describe, it, expect } from 'vitest';
import { formatDuration, formatElapsed } from './format';

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const end = '2024-01-01T00:00:45.000Z';
    expect(formatDuration(start, end)).toBe('45s');
  });

  it('formats durations over a minute as Xm Ys', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const end = '2024-01-01T00:02:30.000Z';
    expect(formatDuration(start, end)).toBe('2m 30s');
  });

  it('formats exactly 60 seconds as 1m 0s', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const end = '2024-01-01T00:01:00.000Z';
    expect(formatDuration(start, end)).toBe('1m 0s');
  });

  it('formats 0 seconds as 0s', () => {
    const start = '2024-01-01T00:00:00.000Z';
    expect(formatDuration(start, start)).toBe('0s');
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute values as Xs', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(30)).toBe('30s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('formats negative values as 0s', () => {
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('formats minutes as M:SS', () => {
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(90)).toBe('1:30');
    expect(formatElapsed(125)).toBe('2:05');
  });

  it('pads seconds below 10 with a leading zero', () => {
    expect(formatElapsed(65)).toBe('1:05');
  });

  it('floors fractional seconds', () => {
    expect(formatElapsed(30.9)).toBe('30s');
    expect(formatElapsed(61.9)).toBe('1:01');
  });
});

