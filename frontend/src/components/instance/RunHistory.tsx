import { StatusBadge } from '../ui/StatusBadge';
import { formatDuration } from '../../lib/format';
import type { StageRun } from '../../lib/api';

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}

export function RunHistory({ runs }: { runs: StageRun[] }) {
  if (!runs || runs.length === 0) return null;

  return (
    <div>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">Run History</div>
      <div className="space-y-2">
        {runs.map((run, i) => (
          <div
            key={i}
            className={`rounded-lg border p-3 ${
              run.status === 'completed'
                ? 'border-green-300 dark:border-green-500/30 bg-status-success-muted'
                : run.status === 'failed'
                  ? 'border-red-300 dark:border-red-500/30 bg-status-error-muted'
                  : 'border-blue-300 dark:border-blue-500/30 bg-status-info-muted'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={run.status} />
                <span className="text-[10px] text-text-tertiary">Run #{run.iteration + 1}</span>
              </div>
              <div className="text-[10px] text-text-muted">
                {run.started_at && run.completed_at ? formatDuration(run.started_at, run.completed_at) : 'running...'}
              </div>
            </div>
            <div className="text-[10px] text-text-muted">
              Started: {formatTimestamp(run.started_at)}
              {run.completed_at && <> | Ended: {formatTimestamp(run.completed_at)}</>}
            </div>
            {run.error && (
              <div className="mt-2">
                <pre className="text-[11px] font-mono text-red-600 dark:text-red-400 bg-status-error-muted rounded p-2 overflow-x-auto max-h-48 whitespace-pre">
                  {run.error}
                </pre>
              </div>
            )}
            {run.output && (
              <div className="mt-2">
                {Array.isArray(run.output) ? (
                  <details>
                    <summary className="text-[10px] text-text-tertiary cursor-pointer hover:text-text-primary select-none">
                      Output: {run.output.length} item{run.output.length !== 1 ? 's' : ''}
                    </summary>
                    <div className="mt-1 space-y-1 max-h-48 overflow-y-auto">
                      {run.output.map((item, idx) => (
                        <pre
                          key={idx}
                          className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto whitespace-pre-wrap break-words"
                        >
                          <span className="text-text-muted mr-1">[{idx}]</span>
                          {typeof item === 'string' ? item : JSON.stringify(item, null, 2)}
                        </pre>
                      ))}
                    </div>
                  </details>
                ) : (
                  <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-32 whitespace-pre-wrap break-words">
                    {typeof run.output === 'string'
                      ? run.output
                      : JSON.stringify(run.output, null, 2)}
                  </pre>
                )}
              </div>
            )}
            {/* Console output / logs */}
            {(run.logs || run.stderr) && (
              <details className="mt-2">
                <summary className="text-[10px] text-text-tertiary cursor-pointer hover:text-text-secondary">
                  Console Output
                </summary>
                <div className="mt-1 space-y-1">
                  {run.logs && (
                    <pre className="text-[11px] font-mono text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                      {run.logs}
                    </pre>
                  )}
                  {run.stderr && (
                    <pre className="text-[11px] font-mono text-amber-500 bg-amber-950/20 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                      {run.stderr}
                    </pre>
                  )}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
