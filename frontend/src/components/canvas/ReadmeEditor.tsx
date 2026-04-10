import { useState, useEffect } from 'react';
import { Maximize2, Minimize2, Eye, Edit3, X } from 'lucide-react';
import { StreamingMarkdown } from '../chat/StreamingMarkdown';

interface ReadmeEditorProps {
  value: string;
  onChange: (val: string) => void;
  readonly?: boolean;
  placeholder?: string;
  /** Title for the modal header (defaults to "README"). */
  title?: string;
  /** When true, only renders the modal — no inline content. */
  modalOnly?: boolean;
  /** Externally control the modal's open state (overrides internal state when defined). */
  expanded?: boolean;
  /** Called when the modal is closed (via X, Escape, or backdrop click). Required when expanded is controlled. */
  onClose?: () => void;
}

export function ReadmeEditor({
  value,
  onChange,
  readonly,
  placeholder,
  title = 'README',
  modalOnly = false,
  expanded: expandedProp,
  onClose,
}: ReadmeEditorProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = expandedProp ?? internalExpanded;
  const setExpanded = (val: boolean) => {
    if (expandedProp !== undefined) {
      if (!val) onClose?.();
    } else {
      setInternalExpanded(val);
    }
  };
  const [mode, setMode] = useState<'view' | 'edit'>(value ? 'view' : 'edit');

  // When the user opens an empty README, default to edit mode
  useEffect(() => {
    if (!value && mode === 'view') setMode('edit');
  }, [value, mode]);

  // Close modal on Escape
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

  const renderToolbar = () => (
    <div className="flex items-center gap-1">
      {!readonly && (
        <div className="flex items-center bg-surface-secondary rounded p-0.5">
          <button
            type="button"
            onClick={() => setMode('view')}
            className={`px-2 py-1 text-[10px] rounded flex items-center gap-1 transition-colors ${
              mode === 'view' ? 'bg-surface text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Eye className="w-3 h-3" /> View
          </button>
          <button
            type="button"
            onClick={() => setMode('edit')}
            className={`px-2 py-1 text-[10px] rounded flex items-center gap-1 transition-colors ${
              mode === 'edit' ? 'bg-surface text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Edit3 className="w-3 h-3" /> Edit
          </button>
        </div>
      )}
      {!modalOnly && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-text-tertiary hover:text-text-primary transition-colors p-1"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      )}
      {modalOnly && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-text-tertiary hover:text-text-primary transition-colors p-1"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  const renderContent = (isExpanded: boolean) => {
    if (mode === 'edit' && !readonly) {
      return (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={isExpanded ? 24 : 6}
          placeholder={placeholder || 'Write a README in markdown...'}
          className="w-full bg-surface-secondary border border-border rounded px-3 py-2 text-sm text-text-primary font-mono resize-none focus:outline-none focus:border-blue-500"
          spellCheck={false}
          autoFocus={isExpanded}
        />
      );
    }
    // View mode
    if (!value) {
      return (
        <div className="text-xs text-text-tertiary italic px-3 py-4">
          No README.{' '}
          {!readonly && (
            <button onClick={() => setMode('edit')} className="text-blue-500 hover:underline">
              Add one
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="bg-surface-secondary border border-border rounded px-3 py-2 max-h-[400px] overflow-y-auto">
        <StreamingMarkdown content={value} />
      </div>
    );
  };

  return (
    <div className="space-y-1.5">
      {/* Inline mode (skipped when modalOnly is true) */}
      {!modalOnly && !expanded && (
        <>
          {renderContent(false)}
          <div className="flex justify-end">{renderToolbar()}</div>
        </>
      )}

      {/* Expanded modal */}
      {expanded && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setExpanded(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
            <div className="bg-surface border border-border rounded-xl w-[90vw] max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl pointer-events-auto">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
                <span className="text-xs font-medium text-text-secondary">{title}</span>
                {renderToolbar()}
              </div>
              <div className="flex-1 overflow-auto p-4">{renderContent(true)}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
