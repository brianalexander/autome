import { describe, it, expect } from 'vitest';
import { formatDuration, formatElapsed, stripMarkdown } from './format';

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

describe('stripMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('strips heading markers', () => {
    expect(stripMarkdown('# Title')).toBe('Title');
    expect(stripMarkdown('### Smaller')).toBe('Smaller');
  });

  it('strips bold and italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
    expect(stripMarkdown('__also bold__ and _also italic_')).toBe('also bold and also italic');
  });

  it('strips inline code backticks', () => {
    expect(stripMarkdown('use `child_process` here')).toBe('use child_process here');
  });

  it('strips link syntax keeping the label', () => {
    expect(stripMarkdown('see [docs](https://example.com)')).toBe('see docs');
  });

  it('strips list bullets', () => {
    expect(stripMarkdown('- one\n- two\n- three')).toBe('one two three');
    expect(stripMarkdown('1. first\n2. second')).toBe('first second');
  });

  it('collapses whitespace and trims', () => {
    expect(stripMarkdown('  hello   world  ')).toBe('hello world');
  });

  it('handles a multi-line README into a single line', () => {
    const input = '# My Workflow\n\nThis does **important** things.\n\n- step 1\n- step 2';
    expect(stripMarkdown(input)).toBe('My Workflow This does important things. step 1 step 2');
  });
});

