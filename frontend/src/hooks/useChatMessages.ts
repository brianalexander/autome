/**
 * useChatMessages — owns message state, streaming text accumulation,
 * and the "flush streaming text into messages" logic for ACP chat sessions.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ToolCallRecord } from '../lib/api';
import type { LiveSegment, ChatMessage } from '../lib/chatUtils';

interface InitialMessage {
  role: 'user' | 'assistant';
  content: string;
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
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
      return { role: m.role, timestamp: m.timestamp, segments };
    });
    return { restoredMessages: msgs, restoredToolCalls: toolCalls };
  }, [initialMessages]);

  const [messages, setMessages] = useState<ChatMessage[]>(restoredMessages);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveToolCalls, setLiveToolCalls] = useState<Map<string, ToolCallRecord>>(restoredToolCalls);

  // Re-seed if initialMessages changes after mount (e.g., react-query cache update)
  const prevInitialRef = useRef(initialMessages);
  useEffect(() => {
    if (prevInitialRef.current === initialMessages) return;
    prevInitialRef.current = initialMessages;
    if (restoredMessages.length > 0) {
      setMessages(restoredMessages);
      setLiveToolCalls(restoredToolCalls);
    }
  }, [initialMessages, restoredMessages, restoredToolCalls]);

  // Flush accumulated streaming text into the last assistant message's segments.
  // Extracted here to eliminate the duplicated inline version across tool_call and done handlers.
  const flushStreamingText = useCallback((textToFlush: string) => {
    if (!textToFlush) return;
    setMessages((msgs) => {
      const updated = [...msgs];
      let target = updated[updated.length - 1];
      if (!target || target.role !== 'assistant') {
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

  // Atomically flush any pending streaming text then append a tool segment to the
  // current assistant message. Uses a setStreamingText updater to read-and-clear
  // atomically so nothing is lost between the two state updates.
  const appendToolSegment = useCallback((toolCallId: string) => {
    setStreamingText((prev) => {
      if (prev) flushStreamingText(prev);
      setMessages((msgs) => {
        const updated = [...msgs];
        let target = updated[updated.length - 1];
        if (!target || target.role !== 'assistant') {
          target = { role: 'assistant', segments: [], timestamp: new Date().toISOString() };
          updated.push(target);
        } else {
          target = { ...target, segments: [...target.segments] };
          updated[updated.length - 1] = target;
        }
        target.segments.push({ type: 'tool', toolCallId });
        return updated;
      });
      return '';
    });
  }, [flushStreamingText]);

  // Finalize the current turn: flush any remaining streaming text and clear streaming state.
  const finalizeTurn = useCallback(() => {
    setStreamingText((prev) => {
      if (prev) flushStreamingText(prev);
      return '';
    });
    setIsStreaming(false);
  }, [flushStreamingText]);

  // Add a user message and mark streaming as started.
  const addUserMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        segments: [{ type: 'text', content: text }],
        timestamp: new Date().toISOString(),
      },
    ]);
    setIsStreaming(true);
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
    setStreamingText((prev) => prev + text);
    setIsStreaming(true);
  }, []);

  // Merge a partial or complete tool call record update into liveToolCalls.
  const updateToolCall = useCallback((tcId: string, update: Partial<ToolCallRecord> & { id: string }) => {
    setLiveToolCalls((prev) => {
      const next = new Map(prev);
      const existing = next.get(tcId);
      next.set(tcId, {
        ...(existing || { id: tcId, title: null, kind: null, created_at: new Date().toISOString() }),
        ...update,
        updated_at: new Date().toISOString(),
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
