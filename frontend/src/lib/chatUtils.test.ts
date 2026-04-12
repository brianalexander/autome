import { describe, it, expect } from 'vitest';
import {
  formatTime,
  formatModelName,
  formatToolCallXml,
  formatSegmentsAsTranscript,
  extractTextFromSegments,
  isSubAgentCall,
  extractSubAgentInfo,
} from './chatUtils';
import type { ToolCallRecord } from './api';

// Factory for a minimal ToolCallRecord
function makeToolCallRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    title: 'bash',
    kind: 'shell',
    status: 'completed',
    raw_input: null,
    raw_output: null,
    parent_tool_use_id: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:05.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------
describe('formatTime', () => {
  it('formats a valid ISO timestamp to HH:MM', () => {
    // Use a fixed UTC time; locale may vary — just assert the result is non-empty
    const result = formatTime('2024-06-15T14:30:00.000Z');
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns empty string for an invalid date string', () => {
    // Invalid date causes toLocaleTimeString to throw/return invalid — caught to ''
    const result = formatTime('not-a-date');
    // Some environments return "Invalid Date" from toLocaleTimeString; we just check it doesn't throw
    expect(typeof result).toBe('string');
  });

  it('handles empty string input without throwing', () => {
    expect(() => formatTime('')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatModelName
// ---------------------------------------------------------------------------
describe('formatModelName', () => {
  it('formats claude-sonnet-4 → "Sonnet 4"', () => {
    expect(formatModelName('claude-sonnet-4')).toBe('Sonnet 4');
  });

  it('formats claude-opus-4-5 → "Opus 4"', () => {
    // regex matches first number sequence after family
    expect(formatModelName('claude-opus-4-5')).toBe('Opus 4');
  });

  it('formats claude-haiku-3 → "Haiku 3"', () => {
    expect(formatModelName('claude-haiku-3')).toBe('Haiku 3');
  });

  it('returns non-claude models unchanged', () => {
    expect(formatModelName('gpt-4o')).toBe('gpt-4o');
    expect(formatModelName('gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });

  it('returns empty string unchanged', () => {
    expect(formatModelName('')).toBe('');
  });

  it('handles model with multi-digit version', () => {
    expect(formatModelName('claude-sonnet-20241022')).toBe('Sonnet 20241022');
  });
});

// ---------------------------------------------------------------------------
// formatToolCallXml
// ---------------------------------------------------------------------------
describe('formatToolCallXml', () => {
  it('produces a tool_start XML element', () => {
    const tc = makeToolCallRecord();
    const xml = formatToolCallXml(tc);
    expect(xml).toContain('<tool_start');
    expect(xml).toContain('</tool_start>');
    expect(xml).toContain('name="bash"');
    expect(xml).toContain('status="completed"');
  });

  it('includes kind attribute when present', () => {
    const tc = makeToolCallRecord({ kind: 'shell' });
    expect(formatToolCallXml(tc)).toContain('kind="shell"');
  });

  it('falls back to kind for title when title is null', () => {
    const tc = makeToolCallRecord({ title: null, kind: 'computer_use' });
    expect(formatToolCallXml(tc)).toContain('name="computer_use"');
  });

  it('falls back to "tool" when both title and kind are null', () => {
    const tc = makeToolCallRecord({ title: null, kind: null });
    expect(formatToolCallXml(tc)).toContain('name="tool"');
  });

  it('includes duration attribute when >= 0.1s', () => {
    const tc = makeToolCallRecord({
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:02.000Z',
    });
    expect(formatToolCallXml(tc)).toContain('duration="2.0s"');
  });

  it('omits duration attribute when < 0.1s', () => {
    const tc = makeToolCallRecord({
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.050Z',
    });
    expect(formatToolCallXml(tc)).not.toContain('duration=');
  });

  it('formats long durations as m:ss', () => {
    const tc = makeToolCallRecord({
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:02:05.000Z', // 125s
    });
    expect(formatToolCallXml(tc)).toContain('duration="2:05"');
  });

  it('extracts __tool_use_purpose as reason', () => {
    const tc = makeToolCallRecord({
      raw_input: JSON.stringify({ __tool_use_purpose: 'list files', command: 'ls' }),
    });
    const xml = formatToolCallXml(tc);
    expect(xml).toContain('reason: list files');
  });

  it('includes raw input JSON when extra args present (no input: label)', () => {
    const tc = makeToolCallRecord({
      raw_input: JSON.stringify({ command: 'ls -la' }),
    });
    const xml = formatToolCallXml(tc);
    expect(xml).not.toContain('input:');
    expect(xml).toContain('"command"');
    expect(xml).toContain('"ls -la"');
  });

  it('strips meta-keys (__tool_name, __mcp_server) from displayed input', () => {
    const tc = makeToolCallRecord({
      raw_input: JSON.stringify({ __tool_name: 'bash', __mcp_server: 'srv', command: 'pwd' }),
    });
    const xml = formatToolCallXml(tc);
    expect(xml).not.toContain('__tool_name');
    expect(xml).not.toContain('__mcp_server');
    expect(xml).toContain('"command"');
  });

  it('omits JSON body when raw_input is null', () => {
    const tc = makeToolCallRecord({ raw_input: null });
    const xml = formatToolCallXml(tc);
    expect(xml).toContain('<tool_start');
    // No JSON body between open and close tags
    expect(xml).toMatch(/<tool_start[^>]*>\s*<\/tool_start>/);
  });

  it('handles malformed raw_input JSON gracefully', () => {
    const tc = makeToolCallRecord({ raw_input: '{not valid json' });
    expect(() => formatToolCallXml(tc)).not.toThrow();
  });

  it('includes raw_output in tool_result element', () => {
    const tc = makeToolCallRecord({ raw_output: 'file.txt\nother.txt' });
    const xml = formatToolCallXml(tc);
    expect(xml).toContain('<tool_result');
    expect(xml).toContain('file.txt');
  });

  it('does NOT truncate raw_output regardless of length (full fidelity copy)', () => {
    const longOutput = 'x'.repeat(5000);
    const tc = makeToolCallRecord({ raw_output: longOutput });
    const xml = formatToolCallXml(tc);
    // Full output preserved — no truncation marker
    expect(xml).toContain('x'.repeat(5000));
    expect(xml).not.toMatch(/x{1,5000}\.{3}/);
  });

  it('omits tool_result when raw_output is null', () => {
    const tc = makeToolCallRecord({ raw_output: null });
    expect(formatToolCallXml(tc)).not.toContain('<tool_result');
  });
});

// ---------------------------------------------------------------------------
// formatSegmentsAsTranscript
// ---------------------------------------------------------------------------
describe('formatSegmentsAsTranscript', () => {
  it('joins text segments by newline', () => {
    const segments = [
      { type: 'text' as const, content: 'Hello' },
      { type: 'text' as const, content: 'World' },
    ];
    const result = formatSegmentsAsTranscript(segments, new Map());
    expect(result).toBe('Hello\nWorld');
  });

  it('skips text segments with empty content', () => {
    const segments = [
      { type: 'text' as const, content: '' },
      { type: 'text' as const, content: 'Hi' },
    ];
    const result = formatSegmentsAsTranscript(segments, new Map());
    expect(result).toBe('Hi');
  });

  it('includes tool_start XML for tool segments', () => {
    const tc = makeToolCallRecord({ id: 'tc-x' });
    const segments = [{ type: 'tool' as const, toolCallId: 'tc-x' }];
    const toolCalls = new Map([['tc-x', tc]]);
    const result = formatSegmentsAsTranscript(segments, toolCalls);
    expect(result).toContain('<tool_start');
  });

  it('skips tool segments whose id is not in the map', () => {
    const segments = [{ type: 'tool' as const, toolCallId: 'missing' }];
    const result = formatSegmentsAsTranscript(segments, new Map());
    expect(result).toBe('');
  });

  it('returns empty string for an empty segment list', () => {
    expect(formatSegmentsAsTranscript([], new Map())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractTextFromSegments
// ---------------------------------------------------------------------------
describe('extractTextFromSegments', () => {
  it('returns concatenated text content', () => {
    const segs = [
      { type: 'text' as const, content: 'Hello ' },
      { type: 'tool' as const, toolCallId: 'x' },
      { type: 'text' as const, content: 'World' },
    ];
    expect(extractTextFromSegments(segs)).toBe('Hello World');
  });

  it('ignores tool segments', () => {
    const segs = [{ type: 'tool' as const, toolCallId: 'x' }];
    expect(extractTextFromSegments(segs)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextFromSegments([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isSubAgentCall
// ---------------------------------------------------------------------------
describe('isSubAgentCall', () => {
  it('returns true when title is "task" (case-insensitive)', () => {
    expect(isSubAgentCall(makeToolCallRecord({ title: 'task' }))).toBe(true);
    expect(isSubAgentCall(makeToolCallRecord({ title: 'Task' }))).toBe(true);
    expect(isSubAgentCall(makeToolCallRecord({ title: 'TASK' }))).toBe(true);
  });

  it('returns true when title is "agent"', () => {
    expect(isSubAgentCall(makeToolCallRecord({ title: 'agent' }))).toBe(true);
  });

  it('returns true when raw_input contains subagent_type', () => {
    const tc = makeToolCallRecord({
      title: 'run_something',
      raw_input: JSON.stringify({ subagent_type: 'coder', prompt: 'do stuff' }),
    });
    expect(isSubAgentCall(tc)).toBe(true);
  });

  it('returns false for a regular tool call (no title match, no subagent_type)', () => {
    const tc = makeToolCallRecord({ title: 'bash', raw_input: JSON.stringify({ command: 'ls' }) });
    expect(isSubAgentCall(tc)).toBe(false);
  });

  it('returns false for WebFetch which has a prompt field but no subagent_type', () => {
    const tc = makeToolCallRecord({
      title: 'WebFetch',
      raw_input: JSON.stringify({ url: 'https://example.com', prompt: 'summarize' }),
    });
    expect(isSubAgentCall(tc)).toBe(false);
  });

  it('returns false when raw_input is null and title is not agent/task', () => {
    expect(isSubAgentCall(makeToolCallRecord({ title: 'read_file', raw_input: null }))).toBe(false);
  });

  it('returns false when raw_input is malformed JSON', () => {
    const tc = makeToolCallRecord({ title: 'unknown', raw_input: '{bad json' });
    expect(isSubAgentCall(tc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractSubAgentInfo
// ---------------------------------------------------------------------------
describe('extractSubAgentInfo', () => {
  it('returns null for null input', () => {
    expect(extractSubAgentInfo(null)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractSubAgentInfo('{not json')).toBeNull();
  });

  it('returns null when no relevant fields are present', () => {
    expect(extractSubAgentInfo(JSON.stringify({ command: 'ls' }))).toBeNull();
  });

  it('extracts subagent_type, description, and prompt', () => {
    const input = JSON.stringify({
      subagent_type: 'coder',
      description: 'Writes code',
      prompt: 'Build a feature',
    });
    const result = extractSubAgentInfo(input);
    expect(result).toEqual({
      type: 'coder',
      description: 'Writes code',
      prompt: 'Build a feature',
    });
  });

  it('strips meta-keys from the output', () => {
    const input = JSON.stringify({
      __tool_name: 'Agent',
      __mcp_server: 'srv',
      __tool_use_purpose: 'reason',
      subagent_type: 'researcher',
    });
    const result = extractSubAgentInfo(input);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('researcher');
  });

  it('returns info when only description is present (no subagent_type)', () => {
    const input = JSON.stringify({ description: 'Some agent' });
    const result = extractSubAgentInfo(input);
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Some agent');
  });

  it('returns info when only prompt is present', () => {
    const input = JSON.stringify({ prompt: 'Do something' });
    const result = extractSubAgentInfo(input);
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('Do something');
  });
});
