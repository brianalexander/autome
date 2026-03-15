import { useState, useRef, useEffect } from 'react';
import { Info } from 'lucide-react';

interface SessionInfoChipProps {
  agentName?: string;
  providerName?: string;
  modelName?: string;
  detectedModel: string | null;
  contextUsage: number | null;
  sessionState?: string;
  isStreaming: boolean;
}

export function SessionInfoChip({
  agentName,
  providerName,
  modelName,
  detectedModel,
  contextUsage,
  sessionState,
  isStreaming,
}: SessionInfoChipProps) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (chipRef.current && !chipRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Status label
  const statusLabel = isStreaming ? 'Active' : sessionState === 'error' ? 'Error' : sessionState === 'starting' ? 'Starting' : 'Idle';

  return (
    <div className="relative" ref={chipRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-0.5 text-text-muted hover:text-text-secondary rounded transition-colors flex-shrink-0"
        title="Session details"
      >
        <Info size={12} />
      </button>

      {open && (
        <div className="fixed z-[100] bg-surface border border-border rounded-lg shadow-lg py-2 px-3 min-w-[200px] max-w-[280px] text-[11px] space-y-1.5"
          style={{
            top: chipRef.current ? chipRef.current.getBoundingClientRect().bottom + 4 : 0,
            left: chipRef.current ? chipRef.current.getBoundingClientRect().left : 0,
          }}>
          {agentName && (
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Agent</span>
              <span className="text-text-primary font-mono truncate">{agentName}</span>
            </div>
          )}
          {providerName && (
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Provider</span>
              <span className="text-text-primary truncate">{providerName}</span>
            </div>
          )}
          {detectedModel && (
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Model</span>
              <span className="text-blue-400 font-mono truncate">{detectedModel}</span>
            </div>
          )}
          {modelName && modelName !== detectedModel && (
            <div className="flex justify-between gap-3">
              <span className="text-text-muted">Configured</span>
              <span className="text-text-secondary font-mono truncate">{modelName}</span>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span className="text-text-muted">Status</span>
            <span className="text-text-primary">{statusLabel}</span>
          </div>
          {contextUsage != null && (
            <div className="flex justify-between gap-3 items-center">
              <span className="text-text-muted">Context</span>
              <div className="flex items-center gap-1.5">
                <div className="w-12 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${contextUsage > 80 ? 'bg-red-500' : contextUsage > 50 ? 'bg-amber-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(contextUsage, 100)}%` }}
                  />
                </div>
                <span className="text-text-secondary tabular-nums">{Math.round(contextUsage)}%</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
