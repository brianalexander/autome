/**
 * NodeDescriptionPopover — info icon that reveals node description + aggregated
 * help-text cards on click. Click-to-toggle so users can select text inside.
 * Closes on outside click.
 *
 * Rendered via ReactDOM.createPortal so the popover escapes any overflow:auto
 * ancestor (e.g. the scrollable sidebar / ConfigPanel). Position is computed
 * with getBoundingClientRect and applied as position:fixed.
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
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

const POPOVER_WIDTH = 288; // w-72 = 18rem = 288px

export function NodeDescriptionPopover({ nodeTypeInfo }: NodeDescriptionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const description = nodeTypeInfo.description?.trim() ?? '';
  const helpMarkdown = aggregateHelpText(nodeTypeInfo);
  const hasContent = description.length > 0 || helpMarkdown.length > 0;

  const handleToggle = useCallback(() => {
    if (!hasContent) return;
    setOpen((prev) => !prev);
  }, [hasContent]);

  // Compute fixed position from button's bounding rect.
  // Aligns popover's right edge to the button's right edge (mirrors the old `right-0`
  // intent). Clamps so the popover left edge never exits the viewport.
  const computePos = useCallback(() => {
    if (typeof window === 'undefined' || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    let right = window.innerWidth - rect.right;
    // If the left edge of the popover would be off-screen, shift right anchor so
    // the popover left edge sits at least 4px inside the viewport.
    if (rect.right - POPOVER_WIDTH < 4) {
      right = Math.max(0, window.innerWidth - rect.left - POPOVER_WIDTH);
    }
    setPos({ top: rect.bottom + 4, right });
  }, []);

  // useLayoutEffect so the popover is positioned before paint (avoids 0,0 flash).
  useLayoutEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    computePos();
    const handler = () => computePos();
    window.addEventListener('resize', handler);
    // capture:true catches scrolls inside any nested scroll container
    window.addEventListener('scroll', handler, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, computePos]);

  // Outside-click detection: close only when the click is outside BOTH the
  // button and the portaled popover div.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
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

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 50 }}
            className="w-72 max-h-80 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg p-3"
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
          </div>,
          document.body,
        )}
    </>
  );
}
