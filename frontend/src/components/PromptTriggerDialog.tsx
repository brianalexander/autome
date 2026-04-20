import { useState, useRef, useEffect } from 'react';

interface PromptTriggerDialogProps {
  workflowName: string;
  isOpen: boolean;
  onClose: () => void;
  onTrigger: (payload: Record<string, unknown>) => void;
  isPending?: boolean;
}

export function PromptTriggerDialog({
  workflowName,
  isOpen,
  onClose,
  onTrigger,
  isPending,
}: PromptTriggerDialogProps) {
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPrompt('');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (!trimmed || isPending) return;
    onTrigger({ prompt: trimmed, attachments: [] });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const submitDisabled = !prompt.trim() || !!isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-subtle rounded-xl w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">Run: {workflowName}</h3>
          <p className="text-xs text-text-secondary mt-1">
            Type a prompt to kick off this workflow.
          </p>
        </div>

        <div className="p-5 space-y-3">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What would you like this workflow to do?"
            className="w-full bg-surface border border-border-subtle rounded-lg px-4 py-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:border-blue-500 focus:ring-blue-500 min-h-[160px] resize-y"
            disabled={isPending}
          />
          <div className="flex items-center justify-end">
            <span className="text-[10px] text-text-muted">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to run
            </span>
          </div>
        </div>

        <div className="p-5 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitDisabled}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
