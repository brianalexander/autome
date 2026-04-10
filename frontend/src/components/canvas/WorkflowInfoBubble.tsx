import { useState, useRef, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { ReadmeEditor } from './ReadmeEditor';
import { stripMarkdown } from '../../lib/format';

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
  const [readmeOpen, setReadmeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside (when README modal is not open)
  useEffect(() => {
    if (readmeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        // Nothing to collapse — bubble is always compact now
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [readmeOpen]);

  const previewText = stripMarkdown(description || '');
  const placeholderText = description ? '' : 'Add a README...';

  return (
    <>
      <div className="absolute top-3 left-3 z-40" ref={containerRef}>
        <div
          className="
            bg-[var(--color-surface)] border border-[var(--color-border)]
            rounded-xl shadow-lg backdrop-blur-sm
            max-w-[280px] px-3 py-2
          "
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
              className="flex-1 text-sm font-semibold bg-transparent border-none focus:outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] min-w-0"
              placeholder="Workflow name..."
            />
          </div>

          {/* Description preview — click to open the README modal */}
          <button
            type="button"
            onClick={() => setReadmeOpen(true)}
            className="block w-full text-left mt-0.5 text-xs text-[var(--color-text-tertiary)] truncate cursor-pointer hover:text-[var(--color-text-secondary)] transition-colors"
            title={previewText || 'Click to add a README'}
          >
            {previewText || placeholderText}
          </button>
        </div>
      </div>

      {/* README editor — modal-only, controlled */}
      <ReadmeEditor
        value={description || ''}
        onChange={onDescriptionChange}
        modalOnly
        title="Workflow README"
        expanded={readmeOpen}
        onClose={() => setReadmeOpen(false)}
      />
    </>
  );
}
