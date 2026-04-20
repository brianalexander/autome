import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AcpChatPane } from '../chat/AcpChatPane';
import { useActiveProvider } from '../../hooks/queries';
import { useChatSegments } from '../../hooks/useChatSegments';
import { assistantApi } from '../../lib/api';

// The assistant uses a fixed global session
const INSTANCE_ID = 'assistant';
const STAGE_ID = 'global';
const EMPTY_FILTER: Record<string, string> = {}; // Stable reference — prevents WS effect re-runs

export function AssistantChat() {
  const queryClient = useQueryClient();
  const { data: activeProvider } = useActiveProvider();

  // Load persisted segments via the assistant-specific endpoint
  // (not the instances endpoint — assistant has its own route)
  const { initialMessages } = useChatSegments(
    ['segments', INSTANCE_ID, STAGE_ID],
    () => assistantApi.getSegments(),
  );

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
      eventFilter={EMPTY_FILTER}  // Stable ref — no filter needed for single global session
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
