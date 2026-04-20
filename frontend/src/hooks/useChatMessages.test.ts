/**
 * Tests for useChatMessages.
 *
 * Core invariants under the simplified re-seed model:
 *
 * 1. Initial render with data → messages are populated via useState initializer.
 * 2. `initialMessages` changes by reference → messages re-seed from the new data.
 * 3. `initialMessages` is the same reference → no-op (prevInitialRef dedup).
 * 4. Re-seed after WS activity → DB wins (regression: pane reopen showed blank transcript).
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatMessages } from './useChatMessages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeInitialMessages = (content: string) => [
  {
    role: 'assistant' as const,
    content,
    timestamp: new Date().toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe('initial render', () => {
  it('populates messages from initialMessages on first render', () => {
    const { result } = renderHook(() => useChatMessages(makeInitialMessages('hello')));

    expect(result.current.messages).toHaveLength(1);
    const seg = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(seg.content).toBe('hello');
  });

  it('starts with empty messages when initialMessages is undefined', () => {
    const { result } = renderHook(() => useChatMessages(undefined));
    expect(result.current.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reference-change re-seed
// ---------------------------------------------------------------------------

describe('reference-change re-seed', () => {
  it('re-seeds messages when initialMessages changes to a new reference', () => {
    const msgA = makeInitialMessages('old content');
    const { result, rerender } = renderHook(
      ({ msgs }) => useChatMessages(msgs),
      { initialProps: { msgs: msgA } },
    );

    expect(
      (result.current.messages[0].segments[0] as { type: 'text'; content: string }).content,
    ).toBe('old content');

    // New reference with genuinely new content (e.g., first load completing)
    const msgB = makeInitialMessages('new content');
    rerender({ msgs: msgB });

    expect(result.current.messages).toHaveLength(1);
    expect(
      (result.current.messages[0].segments[0] as { type: 'text'; content: string }).content,
    ).toBe('new content');
  });

  it('re-seeds even when WS activity occurred before the fetch resolved', () => {
    const msgA = makeInitialMessages('old content');
    const { result, rerender } = renderHook(
      ({ msgs }) => useChatMessages(msgs),
      { initialProps: { msgs: msgA } },
    );

    // Simulate activity that used to block re-seeds under the old guard model
    act(() => {
      result.current.appendChunk('live chunk');
      result.current.finalizeTurn();
    });

    const msgB = makeInitialMessages('updated from DB');
    rerender({ msgs: msgB });

    expect(result.current.messages).toHaveLength(1);
    expect(
      (result.current.messages[0].segments[0] as { type: 'text'; content: string }).content,
    ).toBe('updated from DB');
  });
});

// ---------------------------------------------------------------------------
// Same-reference dedup (prevInitialRef guard)
// ---------------------------------------------------------------------------

describe('same-reference dedup', () => {
  it('does not re-seed when the same initialMessages reference is passed again', () => {
    const msgs = makeInitialMessages('content');
    const { result, rerender } = renderHook(
      ({ msgs }) => useChatMessages(msgs),
      { initialProps: { msgs } },
    );

    // Finalize one turn so text is flushed into the existing assistant message,
    // then add a user message to give us a distinct new entry to detect wipes.
    act(() => {
      result.current.appendChunk('live');
      result.current.finalizeTurn();
      result.current.addUserMessage('user turn');
    });

    // Seeded assistant + new user message
    expect(result.current.messages).toHaveLength(2);

    // Same reference — prevInitialRef dedup should short-circuit; no re-seed
    rerender({ msgs });

    // User message must survive — re-seed would have wiped it back to 1 assistant msg
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Regression: pane reopen showed blank transcript
// ---------------------------------------------------------------------------

describe('regression: pane reopen mid-stream shows full transcript', () => {
  it('seeds historical messages when fetch resolves after WS chunks arrived', () => {
    // Mount with no initial data — fetch is still in-flight
    type Props = { msgs: ReturnType<typeof makeInitialMessages> | undefined };
    const { result, rerender } = renderHook(
      ({ msgs }: Props) => useChatMessages(msgs),
      { initialProps: { msgs: undefined } as Props },
    );

    // WS chunk arrives while fetch is in-flight (simulates pane reopen mid-stream)
    act(() => {
      result.current.appendChunk('live chunk');
    });

    expect(result.current.streamingText).toBe('live chunk');
    // messages is empty — chunk is in streamingText bubble, not flushed yet
    expect(result.current.messages).toHaveLength(0);

    // Fetch resolves with historical messages (what was invisible before this fix)
    const historical = makeInitialMessages('historical content');
    rerender({ msgs: historical });

    // Historical message MUST now be visible — this was the user-reported bug
    expect(result.current.messages).toHaveLength(1);
    expect(
      (result.current.messages[0].segments[0] as { type: 'text'; content: string }).content,
    ).toBe('historical content');

    // Live streaming chunk must still be present in streamingText
    expect(result.current.streamingText).toBe('live chunk');
  });
});

// ---------------------------------------------------------------------------
// Re-seed reconciliation with streamingText (Fix C)
// ---------------------------------------------------------------------------

describe('re-seed reconciliation with streamingText', () => {
  it('full overlap: clears streamingText and finalizing does not duplicate', () => {
    // Mount with no initial data, accumulate a chunk, then re-seed with DB content
    // that already ends with that chunk (full overlap = "ABX" ends with "X").
    type Props = { msgs: ReturnType<typeof makeInitialMessages> | undefined };
    const { result, rerender } = renderHook(
      ({ msgs }: Props) => useChatMessages(msgs),
      { initialProps: { msgs: undefined } as Props },
    );

    act(() => {
      result.current.appendChunk('X');
    });

    expect(result.current.streamingText).toBe('X');

    // DB already has the full 'ABX' (chunk was persisted before broadcast)
    const historical = makeInitialMessages('ABX');
    rerender({ msgs: historical });

    // streamingText must be cleared — 'X' is already in the DB segment
    expect(result.current.streamingText).toBe('');
    const seg = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(seg.content).toBe('ABX');

    // finalizeTurn must NOT append 'X' again
    act(() => {
      result.current.finalizeTurn();
    });
    const segAfter = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(segAfter.content).toBe('ABX');
  });

  it('partial overlap: trims only the already-persisted prefix from streamingText', () => {
    // Chunk 'BC' arrives via WS; DB has caught up to 'AB' (only 'B' overlaps).
    // After reconciliation streamingText should be 'C' (only the un-persisted tail).
    type Props = { msgs: ReturnType<typeof makeInitialMessages> | undefined };
    const { result, rerender } = renderHook(
      ({ msgs }: Props) => useChatMessages(msgs),
      { initialProps: { msgs: undefined } as Props },
    );

    act(() => {
      result.current.appendChunk('BC');
    });

    expect(result.current.streamingText).toBe('BC');

    // DB has 'AB' — the trailing 'B' matches the leading 'B' of streamingText
    const historical = makeInitialMessages('AB');
    rerender({ msgs: historical });

    expect(result.current.streamingText).toBe('C');
    const seg = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(seg.content).toBe('AB');
  });

  it('no overlap: preserves streamingText intact when DB content is unrelated', () => {
    // 'live chunk' has no suffix that is a prefix of 'historical content' — no trim.
    type Props = { msgs: ReturnType<typeof makeInitialMessages> | undefined };
    const { result, rerender } = renderHook(
      ({ msgs }: Props) => useChatMessages(msgs),
      { initialProps: { msgs: undefined } as Props },
    );

    act(() => {
      result.current.appendChunk('live chunk');
    });

    const historical = makeInitialMessages('historical content');
    rerender({ msgs: historical });

    // No overlap — streamingText must be untouched
    expect(result.current.streamingText).toBe('live chunk');
    const seg = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(seg.content).toBe('historical content');
  });

  it('finalizeTurn after full-overlap re-seed does not produce duplicate content', () => {
    // Identical to the first case but explicitly calls finalizeTurn and then
    // checks messages to confirm no duplication occurred.
    type Props = { msgs: ReturnType<typeof makeInitialMessages> | undefined };
    const { result, rerender } = renderHook(
      ({ msgs }: Props) => useChatMessages(msgs),
      { initialProps: { msgs: undefined } as Props },
    );

    act(() => {
      result.current.appendChunk('X');
    });

    rerender({ msgs: makeInitialMessages('ABX') });

    // streamingText was cleared by reconciliation; finalizeTurn has nothing to flush
    act(() => {
      result.current.finalizeTurn();
    });

    // Must still be exactly one message with content 'ABX' — not 'ABXX'
    expect(result.current.messages).toHaveLength(1);
    const seg = result.current.messages[0].segments[0] as { type: 'text'; content: string };
    expect(seg.content).toBe('ABX');
  });
});

// ---------------------------------------------------------------------------
// clearMessages
// ---------------------------------------------------------------------------

describe('clearMessages', () => {
  it('empties messages and allows re-seed on next reference change', () => {
    const msgA = makeInitialMessages('session A');
    const { result, rerender } = renderHook(
      ({ msgs }) => useChatMessages(msgs),
      { initialProps: { msgs: msgA } },
    );

    expect(result.current.messages).toHaveLength(1);

    act(() => {
      result.current.clearMessages();
    });

    expect(result.current.messages).toHaveLength(0);

    // New fetch arrives for a fresh session — should seed
    const msgB = makeInitialMessages('session B content');
    rerender({ msgs: msgB });

    expect(result.current.messages).toHaveLength(1);
    expect(
      (result.current.messages[0].segments[0] as { type: 'text'; content: string }).content,
    ).toBe('session B content');
  });
});
