import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AcpChatPane } from '../chat/AcpChatPane';
import { useSegments, useActiveProvider } from '../../hooks/queries';
import { segmentsToMessages } from '../../lib/segmentsToMessages';
import { authorChat } from '../../lib/api';

interface AuthorChatProps {
  workflowId: string;
  currentDefinition?: unknown;
  onWorkflowUpdated: () => void;
}

export function AuthorChat({ workflowId, currentDefinition, onWorkflowUpdated }: AuthorChatProps) {
  const [sessionState, setSessionState] = useState<'idle' | 'starting' | 'error'>('idle');
  const queryClient = useQueryClient();
  const { data: activeProvider } = useActiveProvider();

  // Load persisted segments (author chat uses instance_id='author', stage_id=workflowId)
  const { data: segments } = useSegments('author', workflowId);

  const initialMessages = useMemo(() => {
    if (!segments?.length) return undefined;
    return segmentsToMessages(segments);
  }, [segments]);

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
  }, [workflowId, queryClient]);

  return (
    <AcpChatPane
      eventPrefix="author"
      eventFilter={{ workflowId }}
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
    />
  );
}
