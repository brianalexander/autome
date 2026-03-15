import { memo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FloatingNodeToolbar } from '../FloatingNodeToolbar';

export interface BaseNodeProps {
  // Identity (from NodeProps)
  id: string;
  selected?: boolean;

  // Appearance
  width?: number;           // default 240
  icon: ReactNode;           // emoji string or Lucide icon element
  label: string;
  subtitle?: string;        // secondary text under label
  subtitleItalic?: boolean; // for "No agent configured" style
  headerTint: string;       // CSS color for header background tint, e.g. '#3b82f6'
  headerTintStrength?: number; // percentage for color-mix, default 8

  // Handles
  handleColor: string;      // CSS var or color
  handleGlowClass: string;  // e.g. 'handle-glow-blue'
  showTargetHandle?: boolean; // default true
  showSourceHandle?: boolean; // default true

  // State
  dimmed?: boolean;         // opacity-50 for skipped

  // Slots for custom content
  headerRight?: ReactNode;  // right side of header row (iteration count, timer, etc.)
  headerExtra?: ReactNode;  // extra content below subtitle in header (condition text, etc.)
  body?: ReactNode;         // main body content (status row, etc.)
  footer?: ReactNode;       // footer below body (output preview, error, actions, etc.)

  // Author toolbar
  isAuthor?: boolean;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onEdit?: (id: string) => void;

  // Test ID
  testId?: string;
}

export const BaseNode = memo(function BaseNode({
  id,
  selected,
  width = 240,
  icon,
  label,
  subtitle,
  subtitleItalic,
  headerTint,
  headerTintStrength = 8,
  handleColor,
  handleGlowClass,
  showTargetHandle = true,
  showSourceHandle = true,
  dimmed,
  headerRight,
  headerExtra,
  body,
  footer,
  isAuthor,
  onDelete,
  onDuplicate,
  onEdit,
  testId,
}: BaseNodeProps) {
  const headerBg = `color-mix(in srgb, ${headerTint} ${headerTintStrength}%, transparent)`;

  return (
    <>
      {isAuthor && (
        <FloatingNodeToolbar
          nodeId={id}
          selected={!!selected}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onEdit={onEdit}
        />
      )}
      <div
        className={[
          'rounded-xl',
          'bg-[var(--node-bg)] backdrop-blur-sm',
          'border border-[var(--node-border)]',
          'shadow-[var(--node-shadow)]',
          'transition-all duration-200 ease-out',
          'hover:shadow-[var(--node-shadow-hover)]',
          selected ? 'shadow-[var(--node-shadow-selected)] border-blue-500/50' : '',
          dimmed ? 'opacity-50' : '',
        ].filter(Boolean).join(' ')}
        style={{ width }}
        data-testid={testId}
      >
        {showTargetHandle && (
          <Handle
            type="target"
            position={Position.Top}
            id="target"
            className={handleGlowClass}
            style={{ background: handleColor }}
          />
        )}

        {/* Inner clip wrapper — prevents header bg leaking past rounded corners */}
        <div className="overflow-hidden rounded-xl">
          {/* Header */}
          <div
            className="px-3.5 py-2.5 border-b border-[var(--node-border)]"
            style={{ background: headerBg }}
          >
            <div className="flex items-center gap-2">
              <div className="flex-shrink-0 w-5 flex items-center justify-center text-[var(--color-text-secondary)]">{icon}</div>
              <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate flex-1">
                {label}
              </span>
              {headerRight}
            </div>
            {subtitle && (
              <div
                className={`text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate ${subtitleItalic ? 'italic' : ''}`}
                title={subtitle}
              >
                {subtitle}
              </div>
            )}
            {headerExtra}
          </div>

          {/* Body */}
          {body}

          {/* Footer */}
          {footer}
        </div>

        {showSourceHandle && (
          <Handle
            type="source"
            position={Position.Bottom}
            id="source"
            className={handleGlowClass}
            style={{ background: handleColor }}
          />
        )}
      </div>
    </>
  );
});
