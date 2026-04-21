/**
 * NodeDescriptionPopover — info icon that reveals node description + aggregated
 * help-text cards on click. Click-to-toggle so users can select text inside.
 * Closes on outside click.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Info } from 'lucide-react';
import { StreamingMarkdown } from '../chat/StreamingMarkdown';
import type { NodeTypeInfo } from '../../lib/api';

interface NodeDescriptionPopoverProps {
  nodeTypeInfo: NodeTypeInfo;
}

/**
 * Aggregate markdown from all `kind: 'help-text'` configCards, in declaration order.
 */
function aggregateHelpText(nodeTypeInfo: NodeTypeInfo): string {
  if (!nodeTypeInfo.configCards) return '';
  return nodeTypeInfo.configCards
    .filter((c): c is Extract<typeof c, { kind: 'help-text' }> => c.kind === 'help-text')
    .map((c) => {
      const lines: string[] = [];
      if (c.title) lines.push(`**${c.title}**`);
      lines.push(c.markdown);
      return lines.join('\n\n');
    })
    .join('\n\n---\n\n');
}

export function NodeDescriptionPopover({ nodeTypeInfo }: NodeDescriptionPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const description = nodeTypeInfo.description?.trim() ?? '';
  const helpMarkdown = aggregateHelpText(nodeTypeInfo);
  const hasContent = description.length > 0 || helpMarkdown.length > 0;

  const handleToggle = useCallback(() => {
    if (!hasContent) return;
    setOpen((prev) => !prev);
  }, [hasContent]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        title={hasContent ? 'Node description' : 'No description'}
        className={
          hasContent
            ? 'text-text-tertiary hover:text-text-primary transition-colors p-1'
            : 'text-text-tertiary/30 p-1 cursor-default pointer-events-none'
        }
        aria-label="Node description"
        disabled={!hasContent}
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          className="
            absolute right-0 top-full mt-1 z-50
            w-72 max-h-80 overflow-y-auto
            bg-surface border border-border rounded-lg shadow-lg p-3
          "
        >
          {description && (
            <div className="mb-2">
              <StreamingMarkdown content={description} />
            </div>
          )}
          {helpMarkdown && (
            <>
              {description && <hr className="border-border my-2" />}
              <StreamingMarkdown content={helpMarkdown} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
