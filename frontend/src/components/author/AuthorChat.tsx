import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AcpChatPane } from '../chat/AcpChatPane';
import { useActiveProvider } from '../../hooks/queries';
import { useChatSegments } from '../../hooks/useChatSegments';
import { authorChat, authorApi, instances } from '../../lib/api';
import type { PendingAuthorMessage } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';

interface AuthorChatProps {
  workflowId: string;
  currentDefinition?: unknown;
  onWorkflowUpdated: () => void;
}

export function AuthorChat({ workflowId, currentDefinition, onWorkflowUpdated }: AuthorChatProps) {
  const [sessionState, setSessionState] = useState<'idle' | 'starting' | 'error'>('idle');
  const queryClient = useQueryClient();
  const { data: activeProvider } = useActiveProvider();
  const { on } = useWebSocket();

  // Stable eventFilter ref — prevents WS subscription effect from re-running every render
  const authorFilter = useMemo(() => ({ workflowId }), [workflowId]);

  // Load persisted segments (author chat uses instance_id='author', stage_id=workflowId)
  const { initialMessages } = useChatSegments(
    ['segments', 'author', workflowId],
    () => instances.getSegments('author', workflowId),
    { enabled: !!workflowId },
  );

  // Ephemeral system messages: flushed pending messages + live WS system messages
  const [ephemeralSystemMessages, setEphemeralSystemMessages] = useState<
    Array<{ text: string; timestamp: string }>
  >([]);

  // Track whether we've flushed for this workflowId to avoid duplicate flushes
  const flushedForRef = useRef<string | null>(null);

  // Flush pending messages on mount / workflowId change
  useEffect(() => {
    if (flushedForRef.current === workflowId) return;
    flushedForRef.current = workflowId;

    authorApi.flushPendingMessages(workflowId).then(({ messages }) => {
      if (messages.length > 0) {
        setEphemeralSystemMessages((prev) => [
          ...prev,
          ...messages.map((m: PendingAuthorMessage) => ({ text: m.text, timestamp: m.created_at || new Date().toISOString() })),
        ]);
      }
    }).catch((err) => {
      console.warn('[AuthorChat] Failed to flush pending messages:', err);
    });
  }, [workflowId]);

  // Subscribe to live author:system_message WS events for this workflow
  useEffect(() => {
    const unsub = on('author:system_message', (data: unknown) => {
      const d = data as { workflowId?: string; text?: string; timestamp?: string };
      if (d.workflowId !== workflowId || !d.text) return;
      setEphemeralSystemMessages((prev) => [
        ...prev,
        { text: d.text!, timestamp: d.timestamp || new Date().toISOString() },
      ]);
    });
    return unsub;
  }, [on, workflowId]);

  const sendMessage = useCallback(
    async (message: string) => {
      try {
        // Sync current canvas state so the AI Author sees unsaved changes
        if (currentDefinition) {
          await fetch(`/api/internal/author-draft/${workflowId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentDefinition),
          });
        }
        const res = await fetch('/api/author/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId, message }),
        });
        if (!res.ok) throw new Error(await res.text());
        setSessionState('idle');
      } catch (err) {
        console.error('Failed to send message:', err);
        setSessionState('error');
      }
    },
    [workflowId, currentDefinition],
  );

  const stopSession = useCallback(async () => {
    try {
      await fetch('/api/author/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      });
    } catch (err) {
      console.error('Failed to stop author session:', err);
    }
  }, [workflowId]);

  const restartSession = useCallback(async () => {
    await authorChat.restartSession(workflowId);
  }, [workflowId]);

  const clearChat = useCallback(async () => {
    await authorChat.clearChat(workflowId);
    // Invalidate segments cache so UI reflects cleared state
    queryClient.invalidateQueries({ queryKey: ['segments', 'author', workflowId] });
    // Clear ephemeral messages too
    setEphemeralSystemMessages([]);
  }, [workflowId, queryClient]);

  return (
    <AcpChatPane
      eventPrefix="author"
      eventFilter={authorFilter}
      placeholder="Describe your workflow..."
      emptyMessage="Describe what workflow you want to build..."
      isActive
      sessionState={sessionState}
      onSendMessage={sendMessage}
      onStop={stopSession}
      onRestartSession={restartSession}
      onClearChat={clearChat}
      onToolResult={() => onWorkflowUpdated()}
      onDone={() => onWorkflowUpdated()}
      agentName="workflow-author"
      providerName={activeProvider?.displayName ?? undefined}
      sessionKey={`author:${workflowId}`}
      initialMessages={initialMessages}
      ephemeralSystemMessages={ephemeralSystemMessages}
    />
  );
}
