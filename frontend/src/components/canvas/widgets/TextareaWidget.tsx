import { useState, useEffect, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { WidgetProps } from './types';

/** Textarea with expand-to-modal for prompt templates and other long-form text. */
export function TextareaWidget({ value, onChange, schema, fieldName: _fieldName, disabled }: WidgetProps<string | undefined>) {
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node && expanded) node.focus();
  }, [expanded]);
  const displayValue = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  // Close on Escape, stop propagation so ConfigPanel doesn't also close
  useEffect(() => {
    if (!expanded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [expanded]);

  return (
    <>
      {/* Backdrop */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setExpanded(false)} />
      )}

      <div className={expanded
        ? 'fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none'
        : 'relative group'
      }>
        <div className={expanded
          ? 'bg-surface border border-border rounded-xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl pointer-events-auto'
          : ''
        }>
          {expanded && (
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
              <span className="text-xs font-medium text-text-secondary">Edit</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-tertiary">Esc to close</span>
                <button
                  onClick={() => setExpanded(false)}
                  className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-surface-secondary"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  Collapse
                </button>
              </div>
            </div>
          )}
          <div className={expanded ? 'flex-1 overflow-auto p-3' : ''}>
            <textarea
              ref={textareaRef}
              value={String(displayValue)}
              onChange={(e) => { if (!disabled) onChange(e.target.value || undefined); }}
              rows={expanded ? 20 : 4}
              disabled={disabled}
              className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y${disabled ? ' opacity-60 cursor-default' : ''}`}
              spellCheck={false}
              placeholder={schema['x-placeholder'] ?? 'Enter prompt template... Use {{ output.field }} for interpolation'}
            />
          </div>
        </div>

        {/* Expand button — inline mode only */}
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-surface-secondary/90 border border-border rounded p-1 text-text-tertiary hover:text-text-primary"
            title="Expand editor"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </>
  );
}
