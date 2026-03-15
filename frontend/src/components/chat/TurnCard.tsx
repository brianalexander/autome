import { useState, useCallback, useMemo } from 'react';
import { Maximize2 } from 'lucide-react';
import type { ToolCallRecord } from '../../lib/api';
import type { ChatMessage } from '../../lib/chatUtils';
import { computeTurnDuration, extractTextFromSegments, formatSegmentsAsTranscript, formatTime } from '../../lib/chatUtils';
import { CopyDropdown } from './CopyDropdown';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ToolCallCard } from './ToolCallCard';

interface TurnCardProps {
  msg: ChatMessage;
  msgIndex: number;
  totalMessages: number;
  isStreaming: boolean;
  streamingText: string;
  liveToolCalls: Map<string, ToolCallRecord>;
  onPermissionResponse?: (toolCallId: string, optionId: string) => void;
  onExpand?: () => void;
}

export function TurnCard({
  msg,
  msgIndex,
  totalMessages,
  isStreaming,
  streamingText,
  liveToolCalls,
  onPermissionResponse,
  onExpand,
}: TurnCardProps) {
  const [copyState, setCopyState] = useState<'idle' | 'text' | 'full'>('idle');
  const isLastMsg = msgIndex === totalMessages - 1;

  // Compute turn duration from tool calls
  const turnDuration = useMemo(() => computeTurnDuration(msg, liveToolCalls), [msg, liveToolCalls]);

  // Copy just the agent text (no tool calls)
  const handleCopyText = useCallback(() => {
    const text = extractTextFromSegments(msg.segments);
    navigator.clipboard.writeText(text);
    setCopyState('text');
    setTimeout(() => setCopyState('idle'), 1500);
  }, [msg.segments]);

  // Copy full output (text + tool calls in XML transcript format)
  const handleCopyFull = useCallback(() => {
    navigator.clipboard.writeText(formatSegmentsAsTranscript(msg.segments, liveToolCalls));
    setCopyState('full');
    setTimeout(() => setCopyState('idle'), 1500);
  }, [msg.segments, liveToolCalls]);

  return (
    <div className="border-t border-b border-border-subtle bg-surface-secondary/30 -mx-2 px-2.5 pt-1.5 pb-1">
      {msg.segments.map((seg, j) => {
        if (seg.type === 'text' && seg.content) {
          const isLastSeg = isLastMsg && j === msg.segments.length - 1;
          const isLiveStreaming = isStreaming && isLastSeg;
          return <StreamingMarkdown key={j} content={seg.content} isStreaming={isLiveStreaming} />;
        }
        if (seg.type === 'tool') {
          const tc = liveToolCalls.get(seg.toolCallId);
          if (!tc) return null;
          return <ToolCallCard key={j} toolCall={tc} onPermissionResponse={onPermissionResponse} />;
        }
        return null;
      })}
      {isLastMsg && isStreaming && streamingText && (
        <StreamingMarkdown content={streamingText} isStreaming />
      )}
      {/* Footer */}
      <div className="flex items-center gap-1.5 mt-1.5 pt-1 border-t border-border-subtle">
        <span className="text-[10px] text-text-muted font-mono tabular-nums">{formatTime(msg.timestamp)}</span>
        {turnDuration && (
          <>
            <span className="text-text-muted text-[10px]">·</span>
            <span className="text-[10px] text-text-muted font-mono tabular-nums">{turnDuration}</span>
          </>
        )}
        <div className="flex items-center gap-0.5 ml-auto">
          <CopyDropdown
            copyState={copyState}
            hasTools={msg.segments.some((s) => s.type === 'tool')}
            onCopyText={handleCopyText}
            onCopyFull={handleCopyFull}
          />
          {onExpand && (
            <button
              onClick={onExpand}
              className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-surface-secondary/50"
              title="Expand in modal"
            >
              <Maximize2 size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
