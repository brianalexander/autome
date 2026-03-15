import { useState, useCallback, useEffect, useMemo } from 'react';
import type { ToolCallRecord } from '../../lib/api';
import type { ChatMessage } from '../../lib/chatUtils';
import { computeTurnDuration, extractTextFromSegments, formatSegmentsAsTranscript, formatTime } from '../../lib/chatUtils';
import { CopyDropdown } from './CopyDropdown';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ToolCallCard } from './ToolCallCard';

export function ExpandedMessageModal({
  msg,
  liveToolCalls,
  onClose,
}: {
  msg: ChatMessage;
  liveToolCalls: Map<string, ToolCallRecord>;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'text' | 'full'>('idle');

  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const handleCopyText = useCallback(() => {
    const text = extractTextFromSegments(msg.segments);
    navigator.clipboard.writeText(text);
    setCopyState('text');
    setTimeout(() => setCopyState('idle'), 1500);
  }, [msg.segments]);

  const handleCopyFull = useCallback(() => {
    navigator.clipboard.writeText(formatSegmentsAsTranscript(msg.segments, liveToolCalls));
    setCopyState('full');
    setTimeout(() => setCopyState('idle'), 1500);
  }, [msg.segments, liveToolCalls]);

  // Compute turn duration
  const turnDuration = useMemo(() => computeTurnDuration(msg, liveToolCalls), [msg, liveToolCalls]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 min-h-0">
          {msg.role === 'user' ? (
            <div className="text-sm text-text-primary whitespace-pre-wrap">
              {msg.segments.map((seg, j) => (seg.type === 'text' ? <span key={j}>{seg.content}</span> : null))}
            </div>
          ) : (
            msg.segments.map((seg, j) => {
              if (seg.type === 'text' && seg.content) {
                return (
                  <div key={j}>
                    <StreamingMarkdown content={seg.content} />
                  </div>
                );
              }
              if (seg.type === 'tool') {
                const tc = liveToolCalls.get(seg.toolCallId);
                if (!tc) return null;
                return <ToolCallCard key={j} toolCall={tc} />;
              }
              return null;
            })
          )}
        </div>

        {/* Footer — timestamp, duration, copy, close */}
        <div className="flex items-center gap-2 px-6 py-2.5 border-t border-border flex-shrink-0 text-xs">
          <span className="text-text-muted font-mono tabular-nums">{formatTime(msg.timestamp)}</span>
          {turnDuration && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted font-mono tabular-nums">{turnDuration}</span>
            </>
          )}
          <div className="flex items-center gap-1 ml-auto">
            <CopyDropdown
              copyState={copyState}
              hasTools={msg.segments.some((s) => s.type === 'tool')}
              onCopyText={handleCopyText}
              onCopyFull={handleCopyFull}
            />
            <button
              onClick={onClose}
              className="px-2.5 py-1 text-text-secondary hover:text-text-primary rounded hover:bg-surface-secondary/50 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
