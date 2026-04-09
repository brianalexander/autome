/**
 * WorkflowSettings — sidebar panel for workflow actions and status.
 * Renders inside the left sidebar's "Settings" tab.
 * Version history has been moved to VersionsPanel (Versions tab).
 */

interface WorkflowSettingsProps {
  isNew: boolean;
  onExport?: () => void;
  healthIndicator?: React.ReactNode;
}

export function WorkflowSettings({
  isNew,
  onExport,
  healthIndicator,
}: WorkflowSettingsProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Workflow status */}
      {!isNew && healthIndicator && (
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
            Status
          </div>
          {healthIndicator}
        </div>
      )}

      {/* Actions */}
      {!isNew && onExport && (
        <div className="px-4 py-3 border-b border-[var(--color-border)]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
            Actions
          </div>
          <button
            onClick={onExport}
            className="w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)] transition-colors"
          >
            <span className="text-base">📦</span>
            Export workflow bundle
          </button>
        </div>
      )}

      {/* New workflow placeholder */}
      {isNew && (
        <div className="px-4 py-8 text-center">
          <div className="text-sm text-[var(--color-text-tertiary)]">
            Save the workflow to access settings.
          </div>
        </div>
      )}
    </div>
  );
}
