/**
 * VersionsPanel — sidebar panel showing workflow version history.
 * Extracted from WorkflowSettings to live on its own "Versions" tab.
 */

interface VersionEntry {
  version: number;
  created_at: string;
}

interface VersionsPanelProps {
  isNew: boolean;
  currentVersion?: number;
  versionHistory?: VersionEntry[];
  restoringVersion: number | null;
  onRestoreVersion: (version: number) => void;
}

export function VersionsPanel({
  isNew,
  currentVersion,
  versionHistory,
  restoringVersion,
  onRestoreVersion,
}: VersionsPanelProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Version History</h2>
      </div>

      {isNew ? (
        <div className="px-4 py-8 text-center">
          <div className="text-sm text-[var(--color-text-tertiary)]">
            Save the workflow to access version history.
          </div>
        </div>
      ) : versionHistory && versionHistory.length > 0 ? (
        <div className="px-4 py-3 space-y-1">
          {versionHistory.map((v) => (
            <div
              key={v.version}
              className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--color-interactive)] transition-colors"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--color-text-primary)]">
                  v{v.version}
                  {v.version === currentVersion && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 font-medium">
                      current
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--color-text-tertiary)]">
                  {new Date(v.created_at).toLocaleString()}
                </div>
              </div>
              {v.version !== currentVersion && (
                <button
                  onClick={() => onRestoreVersion(v.version)}
                  disabled={restoringVersion === v.version}
                  className="flex-shrink-0 px-2 py-1 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-interactive)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
                >
                  {restoringVersion === v.version ? 'Restoring...' : 'Restore'}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-8 text-center">
          <div className="text-sm text-[var(--color-text-tertiary)]">No version history yet.</div>
        </div>
      )}
    </div>
  );
}
