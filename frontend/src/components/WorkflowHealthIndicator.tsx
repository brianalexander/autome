import { useState, useRef, useCallback } from 'react';
import { useWorkflowHealth } from '../hooks/queries';
import { useClickOutside } from '../hooks/useClickOutside';
import type { HealthWarning } from '../lib/api';

interface Props {
  workflowId: string;
}

export function WorkflowHealthIndicator({ workflowId }: Props) {
  const { data: health, isLoading } = useWorkflowHealth(workflowId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setOpen(false), []);
  useClickOutside(ref, closePanel);

  if (isLoading || !health || health.healthy) return null;

  const errors = health.warnings.filter((w) => w.severity === 'error');
  const warnings = health.warnings.filter((w) => w.severity === 'warning');

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="relative px-2 py-1.5 text-sm rounded hover:bg-yellow-50 dark:hover:bg-yellow-900/20 transition-colors"
        title={`${health.warnings.length} issue(s) detected`}
      >
        <span className="text-yellow-500">&#x26A0;</span>
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center text-[10px] font-bold bg-yellow-500 text-white rounded-full px-1">
          {health.warnings.length}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-border">
            <div className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
              {health.warnings.length} dependency issue{health.warnings.length !== 1 ? 's' : ''} detected
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-border/50">
            {errors.length > 0 && (
              <div className="p-2 space-y-1.5">
                {errors.map((w, i) => (
                  <WarningItem key={`e-${i}`} warning={w} />
                ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="p-2 space-y-1.5">
                {warnings.map((w, i) => (
                  <WarningItem key={`w-${i}`} warning={w} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WarningItem({ warning }: { warning: HealthWarning }) {
  const icon = warning.severity === 'error' ? '\u2716' : '\u26A0';
  const color =
    warning.severity === 'error' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400';

  return (
    <div className="flex gap-2 items-start">
      <span className={`text-xs mt-0.5 ${color}`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`text-xs ${color}`}>{warning.message}</div>
        {warning.agentId && <div className="text-[10px] text-text-tertiary mt-0.5">Agent: {warning.agentId}</div>}
      </div>
    </div>
  );
}
