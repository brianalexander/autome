import { useState } from 'react';
import type { EdgeDefinition } from '../../lib/api';

export function EdgeCard({
  edge,
  sourceName,
  targetName,
}: {
  edge: EdgeDefinition;
  sourceName: string;
  targetName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = edge.prompt_template || edge.condition;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`w-full text-left px-3 py-2 ${hasDetails ? 'cursor-pointer hover:bg-interactive' : 'cursor-default'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 text-xs">
            <span className="font-mono text-text-secondary truncate">{sourceName}</span>
            <span className="text-text-muted">{'\u2192'}</span>
            <span className="font-mono text-text-primary truncate">{targetName}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {edge.label && <span className="text-[10px] text-text-tertiary truncate max-w-[100px]">{edge.label}</span>}
            {edge.condition && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400">
                conditional
              </span>
            )}
            {hasDetails && <span className="text-[10px] text-text-muted">{expanded ? '\u25B2' : '\u25BC'}</span>}
          </div>
        </div>
      </button>
      {expanded && hasDetails && (
        <div className="px-3 pb-3 border-t border-border/50 space-y-2">
          {edge.condition && (
            <div className="mt-2">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Condition</div>
              <code className="text-xs text-rose-600 dark:text-rose-300 bg-surface-secondary rounded px-2 py-1 block overflow-x-auto">
                {edge.condition}
              </code>
            </div>
          )}
          {edge.prompt_template && (
            <div className="mt-2">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Prompt Template</div>
              <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
                {edge.prompt_template}
              </pre>
            </div>
          )}
          {edge.max_traversals != null && (
            <div className="mt-2">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Max Traversals</div>
              <span className="text-xs text-text-secondary">{edge.max_traversals}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
