import { useState, useCallback } from 'react';
import { Copy, Check, Maximize2 } from 'lucide-react';
import type { ChatMessage } from '../../lib/chatUtils';
import { extractTextFromSegments, formatTime } from '../../lib/chatUtils';

export function UserMessage({ msg, onExpand }: { msg: ChatMessage; onExpand: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = extractTextFromSegments(msg.segments);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <div className="ml-8">
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/30 rounded-lg px-2.5 pt-1.5 pb-1">
        <div className="text-xs text-blue-600 dark:text-blue-200 whitespace-pre-wrap leading-snug">{text}</div>
        <div className="flex items-center gap-1.5 mt-1.5 pt-1 border-t border-blue-300/60 dark:border-blue-700/40">
          <span className="text-[10px] text-text-muted font-mono tabular-nums">{formatTime(msg.timestamp)}</span>
          <div className="flex items-center gap-0.5 ml-auto">
            <button onClick={handleCopy} className="p-0.5 text-blue-400/40 hover:text-blue-400 rounded transition-colors" title="Copy message">
              {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
            </button>
            <button onClick={onExpand} className="p-0.5 text-blue-400/40 hover:text-blue-400 rounded transition-colors" title="Expand">
              <Maximize2 size={11} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
