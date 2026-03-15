import { useState, useRef, useEffect, useMemo } from 'react';

interface TriggerDialogProps {
  workflowName: string;
  isOpen: boolean;
  onClose: () => void;
  onTrigger: (payload: Record<string, unknown>) => void;
  isPending?: boolean;
}

export function TriggerDialog({ workflowName, isOpen, onClose, onTrigger, isPending }: TriggerDialogProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setInput('');
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Detect if input looks like JSON and validate it
  const jsonStatus = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed) return 'empty' as const;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'text' as const;
    try {
      JSON.parse(trimmed);
      return 'valid' as const;
    } catch {
      return 'invalid' as const;
    }
  }, [input]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    let payload: Record<string, unknown>;
    if (jsonStatus === 'valid') {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } else {
      // Free text — wrap as { prompt: "..." }
      payload = { prompt: trimmed };
    }
    onTrigger(payload);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
    // Tab inserts 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setInput(input.substring(0, start) + '  ' + input.substring(end));
      setTimeout(() => ta.setSelectionRange(start + 2, start + 2), 0);
    }
  };

  const statusIndicator =
    jsonStatus === 'valid'
      ? { text: 'Valid JSON', className: 'text-green-600 dark:text-green-400' }
      : jsonStatus === 'invalid'
        ? { text: 'Invalid JSON', className: 'text-red-600 dark:text-red-400' }
        : jsonStatus === 'text'
          ? { text: 'Free text', className: 'text-text-tertiary' }
          : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-subtle rounded-xl w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">Trigger: {workflowName}</h3>
          <p className="text-xs text-text-secondary mt-1">Enter a prompt or JSON payload for the workflow.</p>
        </div>

        <div className="p-5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter input for the workflow..."
            className={`w-full bg-surface border rounded-lg px-4 py-3 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 min-h-[140px] resize-y ${
              jsonStatus === 'invalid'
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                : 'border-border-subtle focus:border-blue-500 focus:ring-blue-500'
            }`}
            disabled={isPending}
          />
          <div className="flex items-center justify-between mt-2">
            {statusIndicator ? (
              <span className={`text-[10px] font-medium ${statusIndicator.className}`}>{statusIndicator.text}</span>
            ) : (
              <span />
            )}
            <span className="text-[10px] text-text-muted">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to run
            </span>
          </div>
        </div>

        <div className="p-5 border-t border-border flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || isPending || jsonStatus === 'invalid'}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
