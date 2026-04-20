import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CardRendererProps } from './types';
import { useTriggerStatuses, useTriggerLogs } from '../../../hooks/queries';
import type { TriggerStatus } from '../../../lib/api';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Status dot appearance
// ---------------------------------------------------------------------------

interface DotConfig {
  dotClass: string;
  label: string;
  labelClass: string;
}

const STATUS_CONFIG: Record<TriggerStatus['state'], DotConfig> = {
  active: {
    dotClass: 'bg-green-500',
    label: 'Active',
    labelClass: 'text-green-600 dark:text-green-400',
  },
  starting: {
    dotClass: 'bg-blue-500 status-pulse',
    label: 'Starting…',
    labelClass: 'text-blue-600 dark:text-blue-400',
  },
  errored: {
    dotClass: 'bg-red-500',
    label: 'Errored',
    labelClass: 'text-red-600 dark:text-red-400',
  },
  stopped: {
    dotClass: 'bg-[var(--color-text-tertiary)]',
    label: 'Stopped',
    labelClass: 'text-[var(--color-text-tertiary)]',
  },
};

// ---------------------------------------------------------------------------
// Log section (lazy-loaded on expand)
// ---------------------------------------------------------------------------

interface LogSectionProps {
  workflowId: string;
  stageId: string;
}

function LogSection({ workflowId, stageId }: LogSectionProps) {
  const { data, isLoading } = useTriggerLogs(workflowId, stageId, { limit: 50 });

  if (isLoading) {
    return (
      <div className="text-xs text-[var(--color-text-tertiary)] py-2 text-center">
        Loading logs…
      </div>
    );
  }

  const lines = data?.lines ?? [];
  if (lines.length === 0) {
    return (
      <div className="text-xs text-[var(--color-text-tertiary)] py-2 text-center">
        No logs yet
      </div>
    );
  }

  return (
    <pre className="text-[10px] font-mono leading-relaxed text-[var(--color-text-secondary)] bg-[var(--color-surface-tertiary)] rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
      {lines.join('\n')}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Per-stage status row
// ---------------------------------------------------------------------------

interface TriggerStatusRowProps {
  stageId: string;
  status: TriggerStatus;
  workflowId: string;
}

function TriggerStatusRow({ stageId, status, workflowId }: TriggerStatusRowProps) {
  const [logsOpen, setLogsOpen] = useState(false);
  const cfg = STATUS_CONFIG[status.state] ?? STATUS_CONFIG.stopped;

  return (
    <div className="space-y-1.5">
      {/* State row */}
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dotClass}`}
          data-testid="trigger-status-dot"
          data-state={status.state}
        />
        <span className={`text-xs font-medium ${cfg.labelClass}`} data-testid="trigger-status-label">
          {cfg.label}
        </span>
        <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
          since {formatRelative(status.startedAt)}
        </span>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-tertiary)]">
        <span data-testid="trigger-last-event">
          Last event: {formatRelative(status.lastEventAt)}
        </span>
        <span data-testid="trigger-counts">
          Events: {status.eventCount} · Errors: {status.errorCount}
        </span>
      </div>

      {/* Last error */}
      {status.lastError && (
        <div className="text-[10px] text-red-500 dark:text-red-400 truncate" title={status.lastError} data-testid="trigger-last-error">
          {status.lastError}
        </div>
      )}

      {/* Expandable logs */}
      <button
        type="button"
        className="flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
        onClick={() => setLogsOpen((v) => !v)}
        data-testid="trigger-logs-toggle"
      >
        {logsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Logs
      </button>

      {logsOpen && (
        <LogSection workflowId={workflowId} stageId={stageId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivationStatusCard — main export
// ---------------------------------------------------------------------------

export function ActivationStatusCard({ card, stage, workflowId, definition }: CardRendererProps) {
  if (card.kind !== 'activation-status') return null;

  const isWorkflowActive = (definition as { active?: boolean } | undefined)?.active ?? false;
  const { data, isLoading } = useTriggerStatuses(workflowId, { enabled: isWorkflowActive });

  const stageStatus = data?.triggers?.[stage.id];

  return (
    <div className="bg-surface-secondary rounded-lg p-3 space-y-2">
      {card.title && (
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
          {card.title}
        </div>
      )}

      {!isWorkflowActive ? (
        <div className="flex items-center gap-2" data-testid="trigger-inactive">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-[var(--color-text-tertiary)]" />
          <span className="text-xs text-[var(--color-text-tertiary)]">Inactive</span>
        </div>
      ) : isLoading && !data ? (
        <div className="text-xs text-[var(--color-text-tertiary)]">Loading…</div>
      ) : !stageStatus ? (
        /* Workflow is active but this trigger hasn't registered yet */
        <div className="flex items-center gap-2" data-testid="trigger-not-registered">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-[var(--color-text-tertiary)] status-pulse" />
          <span className="text-xs text-[var(--color-text-tertiary)]">Waiting for activation…</span>
        </div>
      ) : (
        <TriggerStatusRow
          stageId={stage.id}
          status={stageStatus}
          workflowId={workflowId}
        />
      )}
    </div>
  );
}
