/**
 * AcpChatPane — Shared chat pane for ACP agent sessions.
 * Used by both the AI Author and the Agent Session Viewer.
 *
 * This component is a thin orchestrator: state lives in useChatMessages
 * and useChatSession hooks, UI in extracted child components.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useChatMessages } from '../../hooks/useChatMessages';
import { useChatSession } from '../../hooks/useChatSession';
import { formatModelName, formatSegmentsAsTranscript } from '../../lib/chatUtils';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ThinkingIndicator } from './ThinkingIndicator';
import { SessionInfoChip } from './SessionInfoChip';
import { UserMessage } from './UserMessage';
import { TurnCard } from './TurnCard';
import { ExpandedMessageModal } from './ExpandedMessageModal';
import { Wand2, RotateCcw, CheckCircle2, XCircle, Loader2, Copy, Check, Trash2 } from 'lucide-react';
import { formatElapsed } from '../../lib/format';
import type { ToolCallRecord } from '../../lib/api';

export interface AcpChatPaneProps {
  /** Event prefix for WebSocket events (e.g., 'agent' or 'author') */
  eventPrefix: string;
  /** Filter key/value to match incoming WebSocket events */
  eventFilter: Record<string, string>;
  /** Placeholder text for the input field */
  placeholder?: string;
  /** Whether the session is active and can receive messages */
  isActive: boolean;
  /** Called when user sends a message */
  onSendMessage: (message: string) => void;
  /** Called when user clicks Stop */
  onStop?: () => void;
  /** Called when a tool_result event arrives (e.g., to refresh workflow) */
  onToolResult?: (data: unknown) => void;
  /** Called when agent turn completes */
  onDone?: () => void;
  /** Called when user responds to a permission request */
  onPermissionResponse?: (toolCallId: string, optionId: string) => void;
  /** Empty state content */
  emptyMessage?: string;
  /** Agent name badge */
  agentName?: string;
  /** ACP provider / client name (e.g., "Claude Code", "Kiro") */
  providerName?: string;
  /** Session key for fetching persisted model info (e.g., "author:workflowId") */
  sessionKey?: string;
  /** Model name badge */
  modelName?: string;
  /** Session lifecycle state */
  sessionState?: 'starting' | 'idle' | 'error';
  /** Called when user clicks "New Session" to restart the ACP session */
  onRestartSession?: () => Promise<void>;
  /** Called when user clicks "Clear chat history" to kill session and wipe all history */
  onClearChat?: () => Promise<void>;
  /** Pre-loaded messages (from DB persistence) */
  initialMessages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    segments?: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }>;
    toolCalls?: Array<Record<string, unknown>>;
  }>;
}

export function AcpChatPane({
  eventPrefix,
  eventFilter,
  placeholder = 'Type a message...',
  isActive,
  onSendMessage,
  onStop,
  onToolResult,
  onDone,
  onPermissionResponse,
  emptyMessage = 'Start a conversation...',
  agentName,
  providerName,
  modelName,
  sessionKey,
  sessionState,
  onRestartSession,
  onClearChat,
  initialMessages,
}: AcpChatPaneProps) {
  // --- Core state hooks ---
  const chat = useChatMessages(initialMessages);
  const session = useChatSession({
    isStreaming: chat.isStreaming,
    streamingText: chat.streamingText,
    sessionKey,
  });

  // --- Local UI state ---
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [expandedModal, setExpandedModal] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // isAtBottomRef is used in the scroll handler (hot path) to avoid re-render storms.
  // isAtBottom is state so the button visibility actually re-renders.
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const { on } = useWebSocket();

  // --- Event filter matching ---
  const matchesFilter = useCallback(
    (data: unknown) => {
      const d = data as Record<string, unknown>;
      return Object.entries(eventFilter).every(([key, value]) => d[key] === value);
    },
    [eventFilter],
  );

  // --- WebSocket subscriptions ---
  useEffect(() => {
    if (!isActive) return;

    const unsubs = [
      on(`${eventPrefix}:chunk`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        chat.appendChunk((d.text as string) || '');
      }),

      on(`${eventPrefix}:tool_call`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        const tcId = d.toolCallId as string;
        const parentToolUseId = d.parentToolUseId as string | undefined;
        chat.appendToolSegment(tcId);
        chat.updateToolCall(tcId, {
          id: tcId,
          title: (d.title as string) || null,
          kind: (d.kind as string) || null,
          status: d.rawInput ? 'in_progress' : 'pending',
          raw_input: d.rawInput
            ? typeof d.rawInput === 'string' ? d.rawInput : JSON.stringify(d.rawInput)
            : null,
          raw_output: null,
          parentToolUseId: parentToolUseId || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as ToolCallRecord);
      }),

      on(`${eventPrefix}:tool_result`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        const tcId = d.toolCallId as string;
        const existing = chat.liveToolCalls.get(tcId);
        const parentToolUseId = (d.parentToolUseId as string | undefined) ?? (existing as (ToolCallRecord & { parentToolUseId?: string }) | undefined)?.parentToolUseId;
        chat.updateToolCall(tcId, {
          id: tcId,
          title: existing?.title ?? null,
          kind: (d.kind as string) || existing?.kind || null,
          status: (d.status as string) || 'completed',
          raw_input: d.rawInput
            ? typeof d.rawInput === 'string' ? d.rawInput : JSON.stringify(d.rawInput)
            : existing?.raw_input || null,
          raw_output: d.rawOutput
            ? typeof d.rawOutput === 'string' ? d.rawOutput : JSON.stringify(d.rawOutput)
            : null,
          parentToolUseId: parentToolUseId || null,
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as ToolCallRecord);
        onToolResult?.(data);
      }),

      on(`${eventPrefix}:context_usage`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        session.setContextUsage(d.percentage as number);
      }),

      on(`${eventPrefix}:mcp_status`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        session.handleMcpStatus(data as Record<string, unknown>);
      }),

      on(`${eventPrefix}:done`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        chat.finalizeTurn();
        session.endTurn();
        onDone?.();
      }),

      on(`${eventPrefix}:cancelled`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        chat.failPendingToolCalls();
        chat.finalizeTurn();
        session.endTurn();
      }),

      on(`${eventPrefix}:model_info`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        if (typeof d.model === 'string') session.setDetectedModel(d.model);
      }),

      on(`${eventPrefix}:error`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        session.endTurn();
        const errorText = d.error as string;
        const stderrText = d.stderr as string | undefined;
        const content = `\u26a0\ufe0f ${errorText}${stderrText ? `\n\n\`\`\`\n${stderrText}\n\`\`\`` : ''}`;
        chat.addSystemMessage(content);
        chat.setIsStreaming(false);
      }),

      on(`${eventPrefix}:stderr`, (data: unknown) => {
        if (!matchesFilter(data)) return;
        const d = data as Record<string, unknown>;
        console.debug(`[${eventPrefix}:stderr]`, d.text);
      }),
    ];

    return () => unsubs.forEach((unsub) => unsub());
  }, [on, eventPrefix, matchesFilter, isActive, onToolResult, onDone, chat, session]);

  // --- Auto-scroll ---
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [chat.messages, chat.streamingText]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Update the ref immediately (no re-render) for auto-scroll logic.
    isAtBottomRef.current = atBottom;
    // Sync state so the button visibility re-renders.
    setIsAtBottom(atBottom);
  }, []);

  // --- Send message ---
  const handleSend = useCallback(() => {
    if (!input.trim() || chat.isStreaming) return;
    const msg = input.trim();
    setInput('');
    chat.addUserMessage(msg);
    session.startTurn();
    // Warn if agent hasn't responded in 90 seconds
    session.promptTimeoutRef.current = setTimeout(() => {
      chat.addSystemMessage(
        '\u26a0\ufe0f Agent has been working for over 90 seconds. It may be stuck. Try stopping and sending again.',
      );
    }, 90000);
    onSendMessage(msg);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    }, 0);
  }, [input, chat, session, onSendMessage]);

  // --- Textarea auto-resize ---
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!chat.isStreaming) handleSend();
      }
    },
    [chat.isStreaming, handleSend],
  );

  // --- Streaming state helpers ---
  const lastAssistantMsg = chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : null;
  const hasStreamingContent =
    chat.isStreaming && (chat.streamingText || (lastAssistantMsg?.role === 'assistant' && lastAssistantMsg.segments.length > 0));

  // --- Header actions ---
  const handleCopyAll = useCallback(() => {
    const parts: string[] = [];
    for (const msg of chat.messages) {
      if (msg.role === 'user') {
        const text = msg.segments
          .filter((s): s is { type: 'text'; content: string } => s.type === 'text' && !!s.content)
          .map((s) => s.content)
          .join('');
        parts.push(`<user_prompt>\n${text}\n</user_prompt>`);
      } else {
        parts.push(formatSegmentsAsTranscript(msg.segments, chat.liveToolCalls));
      }
    }
    navigator.clipboard.writeText(parts.join('\n\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [chat.messages, chat.liveToolCalls]);

  const handleRestartSession = useCallback(async () => {
    if (!onRestartSession) return;
    try {
      await onRestartSession();
      setPendingRestart(true);
    } catch (err) {
      console.error('Failed to restart session:', err);
    }
  }, [onRestartSession]);

  const handleClearChat = useCallback(async () => {
    if (!onClearChat) return;
    try {
      await onClearChat();
      chat.clearMessages();
      setPendingRestart(true);
    } catch (err) {
      console.error('Failed to clear chat:', err);
    }
  }, [onClearChat, chat]);

  // Clear pendingRestart when a new turn starts
  useEffect(() => {
    if (chat.isStreaming && pendingRestart) setPendingRestart(false);
  }, [chat.isStreaming, pendingRestart]);

  // --- Header status dot color ---
  const dotColor = pendingRestart
    ? 'bg-orange-400 animate-pulse'
    : sessionState === 'starting' || (!chat.isStreaming && !chat.streamingText && sessionState !== 'error' && sessionState !== 'idle')
      ? 'bg-purple-400 animate-pulse'
      : chat.isStreaming
        ? 'bg-green-400 animate-pulse'
        : sessionState === 'error'
          ? 'bg-red-400'
          : 'bg-green-400';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header bar */}
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 flex-shrink-0 text-xs">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        {agentName && <span className="text-text-primary font-medium truncate">{agentName}</span>}
        <SessionInfoChip
          agentName={agentName}
          providerName={providerName}
          modelName={modelName}
          detectedModel={session.detectedModel ? formatModelName(session.detectedModel) : null}
          contextUsage={session.contextUsage}
          sessionState={sessionState}
          isStreaming={chat.isStreaming}
        />
        {chat.isStreaming && session.elapsed > 0 && (
          <span className="text-text-muted font-mono tabular-nums text-[10px]">{formatElapsed(session.elapsed)}</span>
        )}
        {session.showWaiting && (
          <span className="text-[10px] text-red-400 animate-pulse flex-shrink-0">stalled</span>
        )}
        <div className="flex items-center gap-0.5 ml-auto bg-surface-secondary/40 rounded-md px-1 py-0.5">
          <button
            onClick={handleCopyAll}
            disabled={chat.messages.length === 0}
            className="text-text-tertiary hover:text-text-secondary disabled:opacity-30 disabled:cursor-default flex-shrink-0 p-1 rounded hover:bg-surface-secondary"
            title="Copy chat"
          >
            {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>
          {onClearChat && (
            <button
              onClick={handleClearChat}
              disabled={chat.isStreaming || pendingRestart}
              className="text-text-tertiary hover:text-text-secondary disabled:opacity-40 disabled:cursor-default flex-shrink-0 p-1 rounded hover:bg-surface-secondary"
              title="Clear chat history"
            >
              <Trash2 size={12} />
            </button>
          )}
          {onRestartSession && (
            <button
              onClick={handleRestartSession}
              disabled={chat.isStreaming || pendingRestart}
              className="text-text-tertiary hover:text-text-secondary disabled:opacity-40 disabled:cursor-default flex-shrink-0 p-1 rounded hover:bg-surface-secondary"
              title="Start new session"
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-2 py-4 space-y-4 min-h-0">
        {chat.messages.length === 0 && !chat.isStreaming && !chat.streamingText && (
          <div className="text-text-tertiary text-sm text-center py-8">{emptyMessage}</div>
        )}

        {chat.messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'system' ? (
              <div className="border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
                <div className="text-xs text-amber-700 dark:text-amber-300 whitespace-pre-wrap font-mono">
                  {msg.segments.map((seg, j) => (seg.type === 'text' ? <span key={j}>{seg.content}</span> : null))}
                </div>
              </div>
            ) : msg.role === 'user' ? (
              <UserMessage msg={msg} onExpand={() => setExpandedModal(i)} />
            ) : (
              <TurnCard
                msg={msg}
                msgIndex={i}
                totalMessages={chat.messages.length}
                isStreaming={chat.isStreaming}
                streamingText={chat.streamingText}
                liveToolCalls={chat.liveToolCalls}
                onPermissionResponse={onPermissionResponse}
                onExpand={() => setExpandedModal(i)}
              />
            )}
          </div>
        ))}

        {/* Streaming text before first assistant message is created */}
        {chat.isStreaming && chat.streamingText && chat.messages[chat.messages.length - 1]?.role !== 'assistant' && (
          <div className="border-t border-b border-border-subtle bg-surface-secondary/30 -mx-2 px-2 py-3">
            <StreamingMarkdown content={chat.streamingText} isStreaming />
          </div>
        )}

        {/* MCP init card */}
        {chat.isStreaming && session.mcpExpected !== null && (session.mcpServers.length > 0 || session.mcpFailed.length > 0 || session.mcpInitializing) && (
          <div className="bg-surface-secondary border border-border-subtle rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                {session.mcpReady ? 'session_init' : 'Initializing session...'}
              </span>
              {session.mcpReady && <span className="text-[10px] text-green-400">Complete</span>}
            </div>
            {session.mcpServers.map((name) => (
              <div key={name} className="flex items-center gap-1.5 pl-1">
                <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />
                <span className="text-xs text-text-secondary font-mono">{name}</span>
              </div>
            ))}
            {session.mcpFailed.map((f) => (
              <div key={f.name} className="flex items-center gap-1.5 pl-1">
                <XCircle size={14} className="text-red-400 flex-shrink-0" />
                <span className="text-xs text-red-400 font-mono">{f.name}</span>
                <span className="text-xs text-text-muted">— {f.error}</span>
              </div>
            ))}
            {session.mcpInitializing && (
              <div className="flex items-center gap-1.5 pl-1">
                <Loader2 size={14} className="text-blue-400 animate-spin flex-shrink-0" />
                <span className="text-xs text-text-muted">
                  {session.mcpExpected
                    ? `Initializing MCP servers (${session.mcpServers.length + session.mcpFailed.length}/${session.mcpExpected})...`
                    : 'Initializing...'}
                </span>
              </div>
            )}
            {session.mcpReady && (
              <div className="flex items-center gap-1.5 pl-1">
                {session.mcpFailed.length > 0 ? (
                  <XCircle size={14} className="text-orange-400 flex-shrink-0" />
                ) : (
                  <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />
                )}
                <span className={`text-xs ${session.mcpFailed.length > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                  Ready ({session.mcpServers.length} server{session.mcpServers.length !== 1 ? 's' : ''}
                  {session.mcpFailed.length > 0 ? `, ${session.mcpFailed.length} failed` : ''})
                </span>
              </div>
            )}
          </div>
        )}

        {/* Thinking indicator */}
        {chat.isStreaming && !chat.streamingText && !hasStreamingContent && session.mcpExpected === null && (
          <ThinkingIndicator />
        )}

        {/* Scroll-to-bottom button */}
        {!isAtBottom && chat.isStreaming && (
          <button
            onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
            className="fixed bottom-20 right-8 bg-surface-tertiary text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-full text-xs shadow-lg border border-border-subtle"
          >
            {'\u2193'} Scroll to bottom
          </button>
        )}
      </div>

      {/* Input bar */}
      <div className="p-3 border-t border-border flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              sessionState === 'starting' ? 'Connecting...' : chat.isStreaming ? 'Agent is working...' : placeholder
            }
            disabled={chat.isStreaming || sessionState === 'starting'}
            rows={1}
            className="flex-1 bg-surface-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed resize-none overflow-hidden"
            style={{ minHeight: '38px', maxHeight: '120px' }}
          />
          {chat.isStreaming && onStop ? (
            <button
              onClick={onStop}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded-lg text-sm flex-shrink-0 transition-colors"
            >
              Stop
            </button>
          ) : (
            <>
              {eventPrefix === 'author' && (
                <button
                  onClick={() => { /* placeholder */ }}
                  disabled={chat.isStreaming || sessionState === 'starting'}
                  className="p-2 border border-border hover:bg-interactive text-text-secondary hover:text-text-primary rounded-lg disabled:opacity-50 flex-shrink-0 transition-colors"
                  title="Magic actions (coming soon)"
                >
                  <Wand2 size={16} />
                </button>
              )}
              <button
                onClick={handleSend}
                disabled={!input.trim() || chat.isStreaming || sessionState === 'starting'}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm disabled:opacity-50 flex-shrink-0 transition-colors"
              >
                Send
              </button>
            </>
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-text-muted">
            {chat.isStreaming ? '' : 'Enter to send, Shift+Enter for newline'}
          </span>
        </div>
      </div>

      {/* Expanded modal */}
      {expandedModal !== null && chat.messages[expandedModal] && (
        <ExpandedMessageModal
          msg={chat.messages[expandedModal]}
          liveToolCalls={chat.liveToolCalls}
          onClose={() => setExpandedModal(null)}
        />
      )}
    </div>
  );
}
