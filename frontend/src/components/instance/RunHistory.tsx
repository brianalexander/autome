import { useState, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { StatusBadge } from '../ui/StatusBadge';
import { formatDuration } from '../../lib/format';
import { formatValue } from '../../lib/formatValue';
import type { StageRun } from '../../lib/api';

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function getDuration(run: StageRun): string {
  if (run.started_at && run.completed_at) {
    return formatDuration(run.started_at, run.completed_at);
  }
  return 'running...';
}

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  running: 'bg-blue-500 animate-pulse',
};

const STATUS_TEXT: Record<string, string> = {
  completed: 'text-green-500',
  failed: 'text-red-500',
  running: 'text-blue-400',
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_DOT[status] ?? 'bg-text-muted';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${color}`} />;
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────

type TabId = 'input' | 'output' | 'error' | 'logs' | 'timing';

interface TabDef {
  id: TabId;
  label: string;
}

function RunDetailModal({ run, onClose }: { run: StageRun; onClose: () => void }) {
  // Build tabs dynamically — only show tabs that have data
  const tabs = useMemo<TabDef[]>(() => {
    const t: TabDef[] = [];
    const hasInput = run.input !== undefined && run.input !== null;
    const hasOutput = run.output !== undefined && run.output !== null;
    const hasError = !!run.error;
    const hasLogs = !!(run.logs || run.stderr);

    if (hasInput) t.push({ id: 'input', label: 'Input' });
    if (hasOutput) {
      const count = Array.isArray(run.output) ? ` (${(run.output as unknown[]).length})` : '';
      t.push({ id: 'output', label: `Output${count}` });
    }
    if (hasError) t.push({ id: 'error', label: 'Error' });
    if (hasLogs) t.push({ id: 'logs', label: 'Logs' });
    t.push({ id: 'timing', label: 'Timing' });
    return t;
  }, [run]);

  const [activeTab, setActiveTab] = useState<TabId>(tabs[0]?.id ?? 'timing');

  // Reset tab when run changes
  useEffect(() => {
    setActiveTab(tabs[0]?.id ?? 'timing');
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-0 flex-shrink-0">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-sm font-semibold text-text-primary">Run #{run.iteration}</span>
            <StatusBadge status={run.status} />
            <span className="text-xs text-text-muted ml-auto mr-3">{getDuration(run)}</span>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex gap-0 border-b border-border -mx-5 px-5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1 px-5 py-4">
          {activeTab === 'input' && (
            <pre className="text-xs font-mono text-text-secondary bg-surface-secondary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {formatValue(run.input)}
            </pre>
          )}

          {activeTab === 'output' && (
            <pre className="text-xs font-mono text-text-secondary bg-surface-secondary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {formatValue(run.output)}
            </pre>
          )}

          {activeTab === 'error' && (
            <pre className="text-xs font-mono text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {run.error}
            </pre>
          )}

          {activeTab === 'logs' && (
            <div className="space-y-3">
              {run.logs && (
                <div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">stdout</div>
                  <pre className="text-xs font-mono text-text-secondary bg-surface-secondary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
                    {run.logs}
                  </pre>
                </div>
              )}
              {run.stderr && (
                <div>
                  <div className="text-[10px] text-amber-500/70 uppercase tracking-wider mb-1.5">stderr</div>
                  <pre className="text-xs font-mono text-amber-400 bg-amber-950/20 border border-amber-900/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
                    {run.stderr}
                  </pre>
                </div>
              )}
            </div>
          )}

          {activeTab === 'timing' && (
            <div className="text-xs text-text-secondary space-y-2">
              <div className="flex gap-2">
                <span className="text-text-muted w-20 flex-shrink-0">Started</span>
                <span>{formatTimestamp(run.started_at)}</span>
              </div>
              {run.completed_at && (
                <div className="flex gap-2">
                  <span className="text-text-muted w-20 flex-shrink-0">Completed</span>
                  <span>{formatTimestamp(run.completed_at)}</span>
                </div>
              )}
              {run.started_at && run.completed_at && (
                <div className="flex gap-2">
                  <span className="text-text-muted w-20 flex-shrink-0">Duration</span>
                  <span>{formatDuration(run.started_at, run.completed_at)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Compact Row ──────────────────────────────────────────────────────────────

function RunRow({ run, onClick }: { run: StageRun; onClick: () => void }) {
  const statusTextClass = STATUS_TEXT[run.status] ?? 'text-text-muted';
  const isRunning = run.status === 'running';

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-surface-secondary transition-colors text-left group"
    >
      <StatusDot status={run.status} />
      <span className="text-xs text-text-primary font-medium">Run #{run.iteration}</span>
      <span className={`text-[10px] ${statusTextClass}`}>{run.status}</span>
      <span className={`text-[10px] text-text-muted ml-auto ${isRunning ? 'animate-pulse' : ''}`}>
        {getDuration(run)}
      </span>
      <svg
        className="w-3 h-3 text-text-muted group-hover:text-text-secondary transition-colors flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function RunHistory({ runs }: { runs: StageRun[] }) {
  const [selectedRun, setSelectedRun] = useState<StageRun | null>(null);

  if (!runs || runs.length === 0) return null;

  return (
    <>
      <div>
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">
          Run History
        </div>
        <div className="space-y-0.5">
          {runs.map((run, i) => (
            <RunRow key={i} run={run} onClick={() => setSelectedRun(run)} />
          ))}
        </div>
      </div>

      {selectedRun && (
        <RunDetailModal run={selectedRun} onClose={() => setSelectedRun(null)} />
      )}
    </>
  );
}
