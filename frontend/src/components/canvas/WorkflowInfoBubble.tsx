import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from '@tanstack/react-router';

interface WorkflowInfoBubbleProps {
  name: string;
  description: string;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  /** If provided, renders ← as a Link to this path */
  backLink?: string;
  /** If provided, renders ← as a button with this handler (used for new workflows) */
  onBack?: () => void;
}

export function WorkflowInfoBubble({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  backLink,
  onBack,
}: WorkflowInfoBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea to content
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, []);

  useEffect(() => {
    if (expanded) autoResize();
  }, [expanded, description, autoResize]);

  // Collapse on click outside — listen on both document and the React Flow pane
  // (the pane captures mousedown before it bubbles to document)
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true); // capture phase
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [expanded]);

  return (
    <div className="absolute top-3 left-3 z-40" ref={containerRef}>
      <div
        className={`
          bg-[var(--color-surface)] border border-[var(--color-border)]
          rounded-xl shadow-lg backdrop-blur-sm
          transition-all duration-200 ease-out
          ${expanded ? 'max-w-[420px] px-3.5 py-3' : 'max-w-[280px] px-3 py-2'}
        `}
      >
        {/* Name row */}
        <div className="flex items-center gap-2">
          {backLink ? (
            <Link
              to={backLink}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm flex-shrink-0 transition-colors"
            >
              ←
            </Link>
          ) : onBack ? (
            <button
              onClick={onBack}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm flex-shrink-0 transition-colors"
            >
              ←
            </button>
          ) : null}
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onFocus={() => setExpanded(true)}
            className="flex-1 text-sm font-semibold bg-transparent border-none focus:outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] min-w-0"
            placeholder="Workflow name..."
          />
        </div>

        {/* Description — single line when collapsed, auto-growing textarea when expanded */}
        {expanded ? (
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => {
              onDescriptionChange(e.target.value);
              autoResize();
            }}
            onFocus={autoResize}
            rows={1}
            className="w-full mt-1.5 text-xs bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text-secondary)] placeholder:text-[var(--color-text-tertiary)] resize-none transition-colors"
            placeholder="Add a description..."
          />
        ) : (
          <div
            onClick={() => setExpanded(true)}
            className="mt-0.5 text-xs text-[var(--color-text-tertiary)] truncate cursor-text"
            title={description || 'Click to add description'}
          >
            {description || 'Add description...'}
          </div>
        )}
      </div>
    </div>
  );
}
