import { Link } from '@tanstack/react-router';
import { StatusBadge } from '../ui/StatusBadge';
import { stripMarkdown } from '../../lib/format';

interface InstanceInfoBubbleProps {
  workflowName?: string;
  workflowDescription?: string;
  effectiveStatus: string;
  versionInfo?: string;
  stageProgress?: string;
  duration?: string | null;
  /** If provided, the ← button calls this instead of navigating */
  onBack?: () => void;
  /** If provided (and onBack is not), the ← links here instead of /instances */
  backLink?: string;
}

export function InstanceInfoBubble({
  workflowName,
  workflowDescription,
  effectiveStatus,
  versionInfo,
  stageProgress,
  duration,
  onBack,
  backLink,
}: InstanceInfoBubbleProps) {
  return (
    <div className="absolute top-3 left-3 z-40 max-w-[360px]">
      <div
        className="
          bg-[var(--color-surface)] border border-[var(--color-border)]
          rounded-xl shadow-lg backdrop-blur-sm
          px-3 py-2.5
        "
      >
        {/* Name row — matches WorkflowInfoBubble layout */}
        <div className="flex items-center gap-2">
          {onBack ? (
            <button
              onClick={onBack}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm flex-shrink-0 transition-colors"
            >
              ←
            </button>
          ) : (
            <Link
              to={backLink ?? '/instances'}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-sm flex-shrink-0 transition-colors"
            >
              ←
            </Link>
          )}
          <span className="flex-1 text-sm font-semibold text-[var(--color-text-primary)] truncate min-w-0">
            {workflowName ?? 'Instance'}
          </span>
        </div>

        {/* Description */}
        {workflowDescription && (
          <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)] truncate">
            {stripMarkdown(workflowDescription)}
          </div>
        )}

        {/* Status line */}
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <StatusBadge status={effectiveStatus} size="sm" />
          {versionInfo && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">{versionInfo}</span>
          )}
          {stageProgress && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">{stageProgress}</span>
          )}
          {duration && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]">{duration}</span>
          )}
        </div>
      </div>
    </div>
  );
}
