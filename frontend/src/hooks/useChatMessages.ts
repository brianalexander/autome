/**
 * useChatMessages — owns message state, streaming text accumulation,
 * and the "flush streaming text into messages" logic for ACP chat sessions.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ToolCallRecord } from '../lib/api';
import type { LiveSegment, ChatMessage } from '../lib/chatUtils';

interface InitialMessage {
  role: 'user' | 'assistant' | 'system';
  content?: string;
  timestamp: string;
  segments?: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }>;
  toolCalls?: Array<Record<string, unknown>>;
}

export function useChatMessages(initialMessages?: InitialMessage[]) {
  // Restore persisted messages and tool calls synchronously for first render
  const { restoredMessages, restoredToolCalls } = useMemo(() => {
    if (!initialMessages?.length) return { restoredMessages: [], restoredToolCalls: new Map<string, ToolCallRecord>() };
    const toolCalls = new Map<string, ToolCallRecord>();
    const msgs: ChatMessage[] = initialMessages.map((m) => {
      // Use native segments if available (new format), otherwise reconstruct from content
      const segments: LiveSegment[] = m.segments
        ? m.segments.map((s) =>
            s.type === 'text'
              ? { type: 'text' as const, content: s.content }
              : { type: 'tool' as const, toolCallId: s.toolCallId },
          )
        : m.content
          ? [{ type: 'text' as const, content: m.content }]
          : [];

      // Populate tool call records from metadata
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          const tcId = tc.toolCallId as string;
          toolCalls.set(tcId, {
            id: tcId,
            title: (tc.title as string) || null,
            kind: (tc.kind as string) || null,
            status: ((tc.status as string) || 'completed') as ToolCallRecord['status'],
            raw_input: tc.rawInput
              ? typeof tc.rawInput === 'string'
                ? tc.rawInput
                : JSON.stringify(tc.rawInput)
              : null,
            raw_output: tc.rawOutput
              ? typeof tc.rawOutput === 'string'
                ? tc.rawOutput
                : JSON.stringify(tc.rawOutput)
              : null,
            parent_tool_use_id: tc.parentToolUseId as string | undefined,
            created_at: (tc.createdAt as string) || new Date().toISOString(),
            updated_at: (tc.updatedAt as string) || new Date().toISOString(),
          });
        }
      }
      return { role: m.role, timestamp: m.timestamp || new Date().toISOString(), segments };
    });
    return { restoredMessages: msgs, restoredToolCalls: toolCalls };
  }, [initialMessages]);

  const [messages, setMessages] = useState<ChatMessage[]>(restoredMessages);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveToolCalls, setLiveToolCalls] = useState<Map<string, ToolCallRecord>>(restoredToolCalls);

  // Synchronous ref mirror of streamingText. React 18's deferred state updaters
  // mean you can't capture state from a setState updater and use it synchronously.
  // This ref is always up-to-date and readable without waiting for a render.
  const streamingTextRef = useRef('');

  // Tracks whether the previous assistant turn has been finalized via `done` /
  // `cancelled`. When true, the NEXT chunk or tool segment must start a new
  // assistant message rather than appending to the previous one — otherwise
  // back-to-back agent turns (e.g. one triggered by an injected message) would
  // be merged into a single bubble with the original turn's timestamp, causing
  // ordering bugs when interleaved with ephemeral system messages.
  const turnFinalizedRef = useRef(false);

  // Re-seed if initialMessages changes after mount (e.g., react-query cache update).
  // CRITICAL: once the user has interacted (sent a message, received chunks, etc.),
  // the live state is authoritative and must NEVER be overwritten by a DB fetch.
  // The isStreaming guard alone isn't sufficient — the re-seed can fire in the same
  // render cycle as finalizeTurn (isStreaming already false), wiping just-flushed text.
  const prevInitialRef = useRef(initialMessages);
  const hasLocalActivityRef = useRef(false);
  useEffect(() => {
    if (prevInitialRef.current === initialMessages) return;
    prevInitialRef.current = initialMessages;
    if (hasLocalActivityRef.current) {
      return;
    }
    if (restoredMessages.length > 0) {
      setMessages(restoredMessages);
      setLiveToolCalls(restoredToolCalls);
    }
  }, [initialMessages, restoredMessages, restoredToolCalls]);

  // Flush accumulated streaming text into the last assistant message's segments.
  // Extracted here to eliminate the duplicated inline version across tool_call and done handlers.
  const flushStreamingText = useCallback((textToFlush: string) => {
    if (!textToFlush) return;
    // Capture-and-clear the turn-finalized flag synchronously so concurrent
    // chunks within the SAME new turn don't each create their own message.
    const startNewTurn = turnFinalizedRef.current;
    if (startNewTurn) turnFinalizedRef.current = false;
    setMessages((msgs) => {
      const updated = [...msgs];
      let target = updated[updated.length - 1];
      if (!target || target.role !== 'assistant' || startNewTurn) {
        target = { role: 'assistant', segments: [], timestamp: new Date().toISOString() };
        updated.push(target);
      } else {
        target = { ...target, segments: [...target.segments] };
        updated[updated.length - 1] = target;
      }
      const lastSeg = target.segments[target.segments.length - 1];
      if (lastSeg && lastSeg.type === 'text') {
        target.segments[target.segments.length - 1] = { type: 'text', content: lastSeg.content + textToFlush };
      } else {
        target.segments.push({ type: 'text', content: textToFlush });
      }
      return updated;
    });
  }, []);

  // Flush any pending streaming text then append a tool segment.
  // Reads accumulated text from the synchronous ref, clears it, then issues two
  // setMessages calls that React 18 batches into one render.
  const appendToolSegment = useCallback((toolCallId: string) => {
    // Step 1: capture and clear streaming text (read from ref — always synchronous)
    const flushedText = streamingTextRef.current;
    streamingTextRef.current = '';
    setStreamingText('');

    // Step 2: flush any pending text, then append the tool segment.
    // React 18 automatic batching groups these two setMessages calls into one render.
    // flushStreamingText already consumed turnFinalizedRef if there was pending
    // text — re-capture here so a tool-first turn (no leading text) still
    // creates a new assistant message.
    if (flushedText) flushStreamingText(flushedText);
    const startNewTurn = turnFinalizedRef.current;
    if (startNewTurn) turnFinalizedRef.current = false;
    setMessages((msgs) => {
      const updated = [...msgs];
      let target = updated[updated.length - 1];
      if (!target || target.role !== 'assistant' || startNewTurn) {
        target = { role: 'assistant', segments: [], timestamp: new Date().toISOString() };
        updated.push(target);
      } else {
        target = { ...target, segments: [...target.segments] };
        updated[updated.length - 1] = target;
      }
      target.segments.push({ type: 'tool', toolCallId });
      return updated;
    });
  }, [flushStreamingText]);

  // Finalize the current turn: flush any remaining streaming text and clear streaming state.
  // Marks the turn as finalized so the NEXT chunk/tool starts a fresh assistant message
  // rather than appending to this one (preventing back-to-back turn merge bugs).
  const finalizeTurn = useCallback(() => {
    const flushedText = streamingTextRef.current;
    streamingTextRef.current = '';
    setStreamingText('');
    if (flushedText) flushStreamingText(flushedText);
    setIsStreaming(false);
    turnFinalizedRef.current = true;
  }, [flushStreamingText]);

  // Add a user message and mark streaming as started.
  const addUserMessage = useCallback((text: string) => {
    hasLocalActivityRef.current = true; // Live state is now authoritative
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        segments: [{ type: 'text', content: text }],
        timestamp: new Date().toISOString(),
      },
    ]);
    setIsStreaming(true);
    streamingTextRef.current = '';
    setStreamingText('');
  }, []);

  // Add a system/error message (displayed inline in the chat as an amber box).
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { role: 'system', segments: [{ type: 'text', content }], timestamp: new Date().toISOString() },
    ]);
  }, []);

  // Append an incremental text chunk from a streaming response.
  const appendChunk = useCallback((text: string) => {
    streamingTextRef.current += text;
    setStreamingText(streamingTextRef.current);
    setIsStreaming(true);
  }, []);

  // Merge a partial or complete tool call record update into liveToolCalls.
  // The fallback created_at/updated_at are only applied when creating a brand-new
  // record (existing is undefined). For existing records the caller must explicitly
  // pass updated_at if it wants to bump the timestamp — preventing spurious
  // duration inflation for DB-restored tool calls that receive live progress events.
  const updateToolCall = useCallback((tcId: string, update: Partial<ToolCallRecord> & { id: string }) => {
    setLiveToolCalls((prev) => {
      const next = new Map(prev);
      const existing = next.get(tcId);
      const nowIso = new Date().toISOString();
      next.set(tcId, {
        ...(existing || { id: tcId, title: null, kind: null, created_at: nowIso, updated_at: nowIso }),
        ...update,
      } as ToolCallRecord);
      return next;
    });
  }, []);

  // Mark any still-pending/in-progress tool calls as failed (used on cancel).
  const failPendingToolCalls = useCallback(() => {
    setLiveToolCalls((prev) => {
      const next = new Map(prev);
      for (const [id, tc] of next) {
        if (tc.status === 'pending' || tc.status === 'in_progress') {
          next.set(id, { ...tc, status: 'failed', updated_at: new Date().toISOString() });
        }
      }
      return next;
    });
  }, []);

  // Clear all messages (used for "clear chat" action).
  const clearMessages = useCallback(() => {
    hasLocalActivityRef.current = false; // Allow re-seed after clear
    streamingTextRef.current = '';
    setMessages([]);
  }, []);

  return {
    messages,
    streamingText,
    isStreaming,
    liveToolCalls,
    setIsStreaming,
    // Actions
    addUserMessage,
    addSystemMessage,
    appendChunk,
    appendToolSegment,
    finalizeTurn,
    updateToolCall,
    failPendingToolCalls,
    clearMessages,
  };
}
