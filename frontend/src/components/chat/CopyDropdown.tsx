import { useState } from 'react';
import { Copy, ChevronDown } from 'lucide-react';

interface CopyDropdownProps {
  copyState: 'idle' | 'text' | 'full';
  hasTools: boolean;
  onCopyText: () => void;
  onCopyFull: () => void;
}

export function CopyDropdown({
  copyState,
  hasTools,
  onCopyText,
  onCopyFull,
}: CopyDropdownProps) {
  const [open, setOpen] = useState(false);

  if (copyState !== 'idle') {
    return <span className="text-[10px] text-green-400 px-1">Copied!</span>;
  }

  // If no tools, just a simple icon copy button
  if (!hasTools) {
    return (
      <button
        onClick={onCopyText}
        className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-surface-secondary/50"
        title="Copy message text"
      >
        <Copy size={12} />
      </button>
    );
  }

  // With tools: icon + tiny dropdown arrow, opens menu
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-surface-secondary/50 flex items-center gap-0.5"
        title="Copy options"
      >
        <Copy size={12} />
        <ChevronDown size={8} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
            <button
              onClick={() => {
                onCopyText();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-secondary hover:bg-surface-secondary"
            >
              Copy Message
              <span className="block text-[9px] text-text-muted">Text only</span>
            </button>
            <button
              onClick={() => {
                onCopyFull();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-secondary hover:bg-surface-secondary"
            >
              Copy Full Output
              <span className="block text-[9px] text-text-muted">Text + tool calls</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
