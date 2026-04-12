import { useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AcpChatPane } from '../chat/AcpChatPane';
import { useActiveProvider } from '../../hooks/queries';
import { segmentsToMessages } from '../../lib/segmentsToMessages';
import { assistantApi } from '../../lib/api';

// The assistant uses a fixed global session
const INSTANCE_ID = 'assistant';
const STAGE_ID = 'global';

export function AssistantChat() {
  const queryClient = useQueryClient();
  const { data: activeProvider } = useActiveProvider();

  // Load persisted segments via the assistant-specific endpoint
  // (not the instances endpoint — assistant has its own route)
  const { data: segments } = useQuery({
    queryKey: ['segments', INSTANCE_ID, STAGE_ID],
    queryFn: () => assistantApi.getSegments(),
    staleTime: Infinity,            // Only refetch when explicitly invalidated (clearChat)
    refetchOnWindowFocus: false,     // Prevent background refetch from wiping live stream
  });

  const initialMessages = useMemo(() => {
    if (!segments?.length) return undefined;
    return segmentsToMessages(segments);
  }, [segments]);

  const sendMessage = useCallback(async (message: string) => {
    await assistantApi.sendMessage(message);
  }, []);

  const stop = useCallback(async () => {
    await assistantApi.stop();
  }, []);

  const restartSession = useCallback(async () => {
    await assistantApi.restartSession();
  }, []);

  const clearChat = useCallback(async () => {
    await assistantApi.clearChat();
    queryClient.invalidateQueries({ queryKey: ['segments', INSTANCE_ID, STAGE_ID] });
  }, [queryClient]);

  return (
    <AcpChatPane
      eventPrefix="assistant"
      eventFilter={{}}  // No filter — single global session, all assistant:* events are ours
      placeholder="Ask the assistant..."
      emptyMessage="Ask anything..."
      isActive
      onSendMessage={sendMessage}
      onStop={stop}
      onRestartSession={restartSession}
      onClearChat={clearChat}
      agentName="assistant"
      providerName={activeProvider?.displayName ?? undefined}
      sessionKey={`${INSTANCE_ID}:${STAGE_ID}`}
      initialMessages={initialMessages}
    />
  );
}
