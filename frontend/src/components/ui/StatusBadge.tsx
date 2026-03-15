export function StatusBadge({ status, size = 'sm' }: { status: string; size?: 'sm' | 'md' }) {
  const styles: Record<string, string> = {
    pending: 'bg-surface-tertiary text-text-secondary',
    running: 'bg-status-info-muted text-status-info',
    waiting_gate: 'bg-status-warning-muted text-status-warning',
    waiting_input: 'bg-status-warning-muted text-status-warning',
    completed: 'bg-status-success-muted text-status-success',
    failed: 'bg-status-error-muted text-status-error',
    cancelled: 'bg-surface-tertiary text-text-tertiary',
    skipped: 'bg-surface-tertiary text-text-tertiary',
  };
  const sizeClass = size === 'md' ? 'text-xs px-2.5 py-1' : 'text-[10px] px-2 py-0.5';
  return (
    <span
      className={`${sizeClass} rounded-full font-medium ${styles[status] ?? 'bg-surface-tertiary text-text-secondary'}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
