import { useState } from 'react';
import { StatusBadge } from '../ui/StatusBadge';

export function StageDataCard({
  stageId,
  stageName,
  status,
  output,
  error,
  runCount,
}: {
  stageId: string;
  stageName?: string;
  status: string;
  output?: unknown;
  error?: string;
  runCount: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const borderColor =
    status === 'completed'
      ? 'border-green-300 dark:border-green-800'
      : status === 'failed'
        ? 'border-red-300 dark:border-red-500/30'
        : status === 'running'
          ? 'border-blue-300 dark:border-blue-800'
          : 'border-border';

  const hasContent = output || error;

  return (
    <div className={`border ${borderColor} rounded-lg overflow-hidden`}>
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`w-full text-left px-3 py-2 flex items-center justify-between ${hasContent ? 'cursor-pointer hover:bg-interactive' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={status} />
          <span className="text-xs font-mono text-text-primary truncate">{stageName || stageId}</span>
          {runCount > 1 && <span className="text-[10px] text-text-muted">x{runCount}</span>}
        </div>
        {hasContent && (
          <span className="text-[10px] text-text-muted flex-shrink-0">{expanded ? '\u25B2' : '\u25BC'}</span>
        )}
      </button>
      {expanded && hasContent && (
        <div className="px-3 pb-3 border-t border-border/50">
          {error && (
            <div className="mt-2">
              <div className="text-[10px] text-red-500 uppercase tracking-wider mb-1">Error</div>
              <pre className="text-xs text-red-600 dark:text-red-400 bg-status-error-muted rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
                {error}
              </pre>
            </div>
          )}
          {!!output && (
            <div className="mt-2">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Output</div>
              <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
