import { useState, useEffect } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { AssistantChat } from './AssistantChat';
import { ResizablePanel } from '../ui/ResizablePanel';

export function AssistantDock() {
  const [isOpen, setIsOpen] = useState(() => {
    return localStorage.getItem('assistant-dock-open') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('assistant-dock-open', String(isOpen));
  }, [isOpen]);

  return (
    <>
      {/* Toggle button — sits on the right edge of the viewport when dock is closed */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="flex-shrink-0 self-stretch w-8 flex items-center justify-center border-l border-border bg-surface hover:bg-surface-secondary text-text-tertiary hover:text-text-primary transition-colors"
          title="Open Assistant"
          aria-label="Open Assistant"
        >
          <MessageSquare size={16} />
        </button>
      )}

      {/* The dock panel — sits to the right of the main content */}
      {isOpen && (
        <ResizablePanel
          side="right"
          defaultWidth={400}
          minWidth={280}
          maxWidth={700}
          className="border-l border-border bg-surface flex flex-col"
        >
          {/* Dock header */}
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 flex-shrink-0">
            <MessageSquare size={14} className="text-text-tertiary flex-shrink-0" />
            <span className="text-sm font-medium text-text-primary flex-1">Assistant</span>
            <button
              onClick={() => setIsOpen(false)}
              className="text-text-tertiary hover:text-text-primary transition-colors p-1 rounded hover:bg-surface-secondary"
              title="Close Assistant"
              aria-label="Close Assistant"
            >
              <X size={14} />
            </button>
          </div>

          {/* Chat fills remaining height */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <AssistantChat />
          </div>
        </ResizablePanel>
      )}
    </>
  );
}
