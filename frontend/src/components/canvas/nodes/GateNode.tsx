import { memo, type ReactNode } from 'react';
import { type NodeProps } from '@xyflow/react';
import { ShieldCheck, Zap, ArrowRight } from 'lucide-react';
import { BaseNode } from './BaseNode';

interface GateNodeData {
  label: string;
  gateType: 'manual' | 'conditional' | 'auto';
  condition?: string;
  message?: string;
  status?: string;
  instanceId?: string;
  stageId?: string;
  approved?: boolean;
  duration?: string;
  onApprove?: () => void;
  onReject?: () => void;
  highlighted?: boolean;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onEdit?: (id: string) => void;
  isAuthor?: boolean;
}

const GATE_TYPE_ICONS: Record<string, ReactNode> = {
  manual: <ShieldCheck className="w-4 h-4" strokeWidth={1.75} />,
  conditional: <Zap className="w-4 h-4" strokeWidth={1.75} />,
  auto: <ArrowRight className="w-4 h-4" strokeWidth={1.75} />,
};

const GATE_TYPE_LABELS: Record<string, string> = {
  manual: 'Manual approval',
  conditional: 'Conditional',
  auto: 'Auto',
};

export const GateNode = memo(function GateNode({ data, selected, id }: NodeProps) {
  const d = data as unknown as GateNodeData;
  const isWaiting = d.status === 'running' && d.gateType === 'manual';
  const isCompleted = d.status === 'completed';
  const isRejected = isCompleted && d.approved === false;
  const isApproved = isCompleted && d.approved === true;
  const isFailed = d.status === 'failed';

  const statusDot = isWaiting
    ? 'bg-amber-400 status-pulse'
    : isApproved ? 'bg-emerald-400'
    : isRejected || isFailed ? 'bg-red-400'
    : 'bg-rose-400';

  const statusLabel = isWaiting
    ? 'text-amber-400'
    : isApproved ? 'text-emerald-400'
    : isRejected || isFailed ? 'text-red-400'
    : 'text-rose-400';

  const statusText = isWaiting
    ? 'Waiting for approval'
    : isApproved ? 'Approved'
    : isRejected ? 'Rejected'
    : isFailed ? 'Failed'
    : d.status || 'pending';

  // Header extra: condition text
  const headerExtra = d.condition ? (
    <div className="mt-1.5 text-[10px] text-[var(--color-text-tertiary)] font-mono truncate" title={d.condition}>
      {d.condition}
    </div>
  ) : null;

  // Body: status row
  const body = d.status ? (
    <div className="px-3.5 py-2 flex items-center gap-1.5" data-testid="gate-status">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot}`} />
      <span className={`text-xs font-medium ${statusLabel}`}>{statusText}</span>
      {d.duration && (
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono tabular-nums ml-auto">
          {d.duration}
        </span>
      )}
    </div>
  ) : null;

  // Footer: approve/reject buttons when waiting
  const footer = isWaiting && d.onApprove ? (
    <div className="flex gap-2 px-3.5 pb-2.5" data-testid="gate-actions">
      <button
        onClick={(e) => { e.stopPropagation(); d.onApprove?.(); }}
        className="flex-1 text-xs bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-lg px-3 py-1.5 transition-colors font-medium"
        data-testid="approve-button"
      >
        ✓ Approve
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); d.onReject?.(); }}
        className="flex-1 text-xs bg-red-700 hover:bg-red-600 active:bg-red-800 text-white rounded-lg px-3 py-1.5 transition-colors font-medium"
        data-testid="reject-button"
      >
        ✕ Reject
      </button>
    </div>
  ) : null;

  return (
    <BaseNode
      id={id}
      selected={selected}
      width={240}
      icon={GATE_TYPE_ICONS[d.gateType] || <ShieldCheck className="w-4 h-4" strokeWidth={1.75} />}
      label={d.label}
      subtitle={GATE_TYPE_LABELS[d.gateType] || d.gateType}
      headerTint="#ec4899"
      handleColor="var(--handle-color-gate)"
      handleGlowClass="handle-glow-pink"
      headerExtra={headerExtra}
      highlighted={d.highlighted}
      body={body}
      footer={footer}
      isAuthor={d.isAuthor}
      onDelete={d.onDelete}
      onDuplicate={d.onDuplicate}
      onEdit={d.onEdit}
      testId="gate-node"
    />
  );
});
