/**
 * useChatSession — manages session-level concerns for ACP chat sessions:
 * elapsed timer, waiting/stalled detection, model detection, context usage,
 * MCP server initialization tracking, and the prompt timeout ref.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { sessionInfo } from '../lib/api';

export function useChatSession(options: {
  isStreaming: boolean;
  sessionKey?: string;
}) {
  const { isStreaming, sessionKey } = options;

  // --- Model detection ---
  const [detectedModel, setDetectedModel] = useState<string | null>(null);
  // Track which sessionKey we've already fetched so the effect doesn't re-fire
  // when detectedModel changes (avoids needing eslint-disable).
  const fetchedModelForRef = useRef<string | undefined>(undefined);

  // Fetch persisted model from DB once per sessionKey (single attempt, not retried).
  useEffect(() => {
    if (!sessionKey || fetchedModelForRef.current === sessionKey) return;
    fetchedModelForRef.current = sessionKey;
    sessionInfo.get(sessionKey).then((info) => {
      if (info.model) setDetectedModel(info.model);
    }).catch(() => {});
  }, [sessionKey]);

  // --- Context usage ---
  const [contextUsage, setContextUsage] = useState<number | null>(null);

  // --- Elapsed timer ---
  const [elapsed, setElapsed] = useState(0);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isStreaming || !turnStartedAt) return;
    const tick = () => setElapsed(Math.max(0, (Date.now() - turnStartedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isStreaming, turnStartedAt]);

  // --- "Waiting/stalled" indicator (>30s no new output) ---
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [waitingTick, setWaitingTick] = useState(0);

  // Reset the stall clock when streaming stops.
  useEffect(() => {
    if (!isStreaming) {
      setWaitingSince(null);
    }
  }, [isStreaming]);

  // resetStallTimer is called directly from the chunk handler so the stall
  // clock resets on actual chunk arrival, not on a render triggered by
  // streamingText changing (which can batch multiple chunks into one update).
  const resetStallTimer = useCallback(() => {
    setWaitingSince(Date.now());
  }, []);

  useEffect(() => {
    if (!isStreaming || waitingSince === null) {
      setWaitingTick(0);
      return;
    }
    const id = setInterval(() => setWaitingTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isStreaming, waitingSince]);

  const showWaiting = isStreaming && waitingSince !== null && waitingTick > 0 && (Date.now() - waitingSince) > 30000;

  // --- Prompt timeout ref — owned here so startTurn/endTurn can manage it ---
  const promptTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => {
    if (promptTimeoutRef.current) clearTimeout(promptTimeoutRef.current);
  }, []);

  // --- MCP server initialization tracking ---
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpFailed, setMcpFailed] = useState<Array<{ name: string; error: string }>>([]);
  const [mcpExpected, setMcpExpected] = useState<number | null>(null);

  const mcpInitializing = isStreaming && mcpExpected !== null && mcpServers.length + mcpFailed.length < mcpExpected;
  const mcpReady = mcpExpected !== null && mcpServers.length + mcpFailed.length >= mcpExpected;

  // Start a new turn: reset timer and MCP init tracking, cancel any pending timeout.
  const startTurn = useCallback(() => {
    setTurnStartedAt(Date.now());
    setElapsed(0);
    setMcpServers([]);
    setMcpFailed([]);
    setMcpExpected(null);
    if (promptTimeoutRef.current) clearTimeout(promptTimeoutRef.current);
  }, []);

  // End a turn: stop the timer and cancel any pending prompt timeout.
  const endTurn = useCallback(() => {
    if (promptTimeoutRef.current) clearTimeout(promptTimeoutRef.current);
    setTurnStartedAt(null);
  }, []);

  // Handle an mcp_status WebSocket event and update MCP tracking state accordingly.
  const handleMcpStatus = useCallback((data: Record<string, unknown>) => {
    if (data.serversExpected != null) setMcpExpected(data.serversExpected as number);
    if (data.event === 'server_ready' && data.serverName) {
      setMcpServers((prev) => (prev.includes(data.serverName as string) ? prev : [...prev, data.serverName as string]));
    } else if (data.event === 'server_failed' && data.serverName) {
      setMcpFailed((prev) =>
        prev.some((f) => f.name === data.serverName)
          ? prev
          : [...prev, { name: data.serverName as string, error: (data.error as string) || 'Unknown error' }],
      );
    }
  }, []);

  return {
    // Model
    detectedModel,
    setDetectedModel,
    // Context
    contextUsage,
    setContextUsage,
    // Timer
    elapsed,
    showWaiting,
    // Prompt timeout (ref passed through so AcpChatPane can schedule the 90s warning)
    promptTimeoutRef,
    // MCP
    mcpServers,
    mcpFailed,
    mcpExpected,
    mcpInitializing,
    mcpReady,
    // Actions
    startTurn,
    endTurn,
    handleMcpStatus,
    resetStallTimer,
  };
}
