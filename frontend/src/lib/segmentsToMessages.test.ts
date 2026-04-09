import { describe, it, expect } from 'vitest';
import { segmentsToMessages } from './segmentsToMessages';
import type { SegmentRecord } from './api';

// Minimal factory for a SegmentRecord so tests stay concise
function makeSeg(
  overrides: Partial<SegmentRecord> & { segment_type: SegmentRecord['segment_type'] },
): SegmentRecord {
  return {
    id: 1,
    segment_index: 0,
    content: null,
    tool_call: null,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeToolCall(id = 'tc1') {
  return {
    id,
    title: 'bash',
    kind: 'computer_use',
    status: 'completed' as const,
    raw_input: JSON.stringify({ command: 'ls' }),
    raw_output: 'file.txt',
    parent_tool_use_id: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:05.000Z',
  };
}

describe('segmentsToMessages', () => {
  it('returns undefined for an empty array', () => {
    expect(segmentsToMessages([])).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    // @ts-expect-error - testing runtime safety
    expect(segmentsToMessages(null)).toBeUndefined();
    // @ts-expect-error - testing runtime safety
    expect(segmentsToMessages(undefined)).toBeUndefined();
  });

  it('converts a single user segment to one user message', () => {
    const segs = [makeSeg({ segment_type: 'user', content: 'Hello', segment_index: 0 })];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].role).toBe('user');
    expect(result![0].content).toBe('Hello');
    expect(result![0].segments).toEqual([{ type: 'text', content: 'Hello' }]);
  });

  it('handles a user segment with null content (treated as empty string)', () => {
    const segs = [makeSeg({ segment_type: 'user', content: null, segment_index: 0 })];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('');
  });

  it('converts a single text segment to one assistant message', () => {
    const segs = [makeSeg({ segment_type: 'text', content: 'Hi there', segment_index: 0 })];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].role).toBe('assistant');
    expect(result![0].content).toBe('Hi there');
  });

  it('merges consecutive text segments into a single assistant message', () => {
    const segs = [
      makeSeg({ segment_type: 'text', content: 'Part 1 ', segment_index: 0 }),
      makeSeg({ segment_type: 'text', content: 'Part 2', segment_index: 1 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].role).toBe('assistant');
    expect(result![0].content).toBe('Part 1 Part 2');
  });

  it('converts a tool segment to an assistant message with toolCalls', () => {
    const tc = makeToolCall('tc-1');
    const segs = [makeSeg({ segment_type: 'tool', tool_call: tc, segment_index: 0 })];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    const msg = result![0];
    expect(msg.role).toBe('assistant');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].toolCallId).toBe('tc-1');
    expect(msg.toolCalls![0].title).toBe('bash');
    expect(msg.toolCalls![0].kind).toBe('computer_use');
    expect(msg.toolCalls![0].status).toBe('completed');
    expect(msg.toolCalls![0].rawInput).toBe(JSON.stringify({ command: 'ls' }));
    expect(msg.toolCalls![0].rawOutput).toBe('file.txt');
  });

  it('groups text and tool segments in the same assistant turn', () => {
    const tc = makeToolCall('tc-2');
    const segs = [
      makeSeg({ segment_type: 'text', content: 'Running now', segment_index: 0 }),
      makeSeg({ segment_type: 'tool', tool_call: tc, segment_index: 1 }),
      makeSeg({ segment_type: 'text', content: ' Done', segment_index: 2 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    const msg = result![0];
    expect(msg.role).toBe('assistant');
    // content is only from text segments
    expect(msg.content).toBe('Running now Done');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.segments).toHaveLength(3);
  });

  it('splits on role boundary: user segment between two assistant turns', () => {
    const segs = [
      makeSeg({ segment_type: 'text', content: 'Greet', segment_index: 0 }),
      makeSeg({ segment_type: 'user', content: 'Reply', segment_index: 1 }),
      makeSeg({ segment_type: 'text', content: 'Response', segment_index: 2 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(3);
    expect(result![0].role).toBe('assistant');
    expect(result![1].role).toBe('user');
    expect(result![2].role).toBe('assistant');
  });

  it('handles text → tool → text as one assistant message', () => {
    const tc = makeToolCall('tc-3');
    const segs = [
      makeSeg({ segment_type: 'text', content: 'Before', segment_index: 0 }),
      makeSeg({ segment_type: 'tool', tool_call: tc, segment_index: 1 }),
      makeSeg({ segment_type: 'text', content: 'After', segment_index: 2 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].role).toBe('assistant');
    expect(result![0].content).toBe('BeforeAfter');
    expect(result![0].toolCalls).toHaveLength(1);
  });

  it('handles multiple user/assistant turn alternation', () => {
    const segs = [
      makeSeg({ segment_type: 'user', content: 'Q1', segment_index: 0 }),
      makeSeg({ segment_type: 'text', content: 'A1', segment_index: 1 }),
      makeSeg({ segment_type: 'user', content: 'Q2', segment_index: 2 }),
      makeSeg({ segment_type: 'text', content: 'A2', segment_index: 3 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(4);
    expect(result!.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(result!.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A2']);
  });

  it('ignores a tool segment that has no tool_call data', () => {
    const segs = [
      makeSeg({ segment_type: 'text', content: 'Hello', segment_index: 0 }),
      // tool segment with null tool_call should be silently skipped
      makeSeg({ segment_type: 'tool', tool_call: null, segment_index: 1 }),
    ];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Hello');
    expect(result![0].toolCalls).toBeUndefined();
  });

  it('ignores a text segment with null content', () => {
    const segs = [
      makeSeg({ segment_type: 'text', content: null, segment_index: 0 }),
    ];
    // null-content text segment produces an empty assistant message — no content, no toolCalls
    // The segment is not pushed (due to the `seg.content` guard), so the flush is a no-op
    const result = segmentsToMessages(segs);
    expect(result).toBeUndefined();
  });

  it('preserves the timestamp from the first segment of each turn', () => {
    const ts = '2024-06-15T12:00:00.000Z';
    const segs = [
      makeSeg({ segment_type: 'user', content: 'Hey', segment_index: 0, created_at: ts }),
    ];
    const result = segmentsToMessages(segs);
    expect(result![0].timestamp).toBe(ts);
  });

  it('handles toolCalls with null optional fields (no title, no kind)', () => {
    const tc = {
      ...makeToolCall('tc-null'),
      title: null,
      kind: null,
      raw_input: null,
      raw_output: null,
      parent_tool_use_id: null,
    };
    const segs = [makeSeg({ segment_type: 'tool', tool_call: tc, segment_index: 0 })];
    const result = segmentsToMessages(segs);
    expect(result).toHaveLength(1);
    const call = result![0].toolCalls![0];
    expect(call.title).toBeUndefined();
    expect(call.kind).toBeUndefined();
    expect(call.rawInput).toBeUndefined();
    expect(call.rawOutput).toBeUndefined();
  });
});
