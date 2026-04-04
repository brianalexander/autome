import { createFileRoute, Link } from '@tanstack/react-router';
import { useApprovals, useApproveGate, useRejectGate } from '../hooks/queries';
import { useState, useCallback } from 'react';
import { CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight } from 'lucide-react';

export const Route = createFileRoute('/approvals')({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { data: approvals, isLoading } = useApprovals();
  const approveGate = useApproveGate();
  const rejectGate = useRejectGate();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-text-muted text-sm">Loading approvals...</span>
      </div>
    );
  }

  if (!approvals || approvals.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <CheckCircle2 className="w-12 h-12 text-green-500/30 mx-auto mb-3" />
          <p className="text-text-secondary text-sm">No pending approvals</p>
          <p className="text-text-muted text-xs mt-1">Gates waiting for approval will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-3">
        {approvals.map((approval) => (
          <ApprovalCard
            key={`${approval.instanceId}-${approval.stageId}`}
            approval={approval}
            onApprove={(data) => approveGate.mutate({ instanceId: approval.instanceId, stageId: approval.stageId, data })}
            onReject={() => rejectGate.mutate({ instanceId: approval.instanceId, stageId: approval.stageId })}
          />
        ))}
      </div>
    </div>
  );
}

interface ApprovalCardProps {
  approval: {
    instanceId: string;
    workflowName: string;
    workflowId: string;
    stageId: string;
    stageLabel: string;
    gateMessage: string | null;
    upstreamData: unknown;
    waitingSince: string;
  };
  onApprove: (data?: unknown) => void;
  onReject: () => void;
}

function ApprovalCard({ approval, onApprove, onReject }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editedData, setEditedData] = useState<string>(() => {
    if (approval.upstreamData === undefined) return '';
    try {
      return JSON.stringify(approval.upstreamData, null, 2);
    } catch {
      return String(approval.upstreamData);
    }
  });
  const [parseError, setParseError] = useState<string | null>(null);

  const handleApprove = useCallback(() => {
    try {
      const parsed = JSON.parse(editedData);
      setParseError(null);
      onApprove(parsed);
    } catch {
      if (editedData.trim()) {
        onApprove(editedData);
      } else {
        onApprove();
      }
    }
  }, [editedData, onApprove]);

  const waitingDuration = (() => {
    const ts = approval.waitingSince.endsWith('Z') ? approval.waitingSince : approval.waitingSince + 'Z';
    const ms = Date.now() - new Date(ts).getTime();
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  })();

  return (
    <div className="bg-surface border border-amber-500/30 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3">
        <Clock size={16} className="text-amber-500 flex-shrink-0 animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">
              {approval.stageLabel}
            </span>
            <span className="text-[10px] text-text-muted">in</span>
            <Link
              to="/instances/$instanceId"
              params={{ instanceId: approval.instanceId }}
              className="text-xs text-blue-400 hover:text-blue-300 truncate"
            >
              {approval.workflowName}
            </Link>
          </div>
          {approval.gateMessage && (
            <p className="text-xs text-text-secondary mt-0.5">{approval.gateMessage}</p>
          )}
        </div>
        <span className="text-[10px] text-text-muted flex-shrink-0">{waitingDuration}</span>
      </div>

      {/* Expandable data editor */}
      {approval.upstreamData !== undefined && (
        <div className="border-t border-border">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-surface-secondary/50 transition-colors"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {expanded ? 'Hide data' : 'Review & edit data'}
          </button>
          {expanded && (
            <div className="px-4 pb-3">
              <textarea
                value={editedData}
                onChange={(e) => {
                  setEditedData(e.target.value);
                  setParseError(null);
                }}
                className="w-full bg-surface-secondary border border-border-subtle rounded-lg px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-blue-500 resize-y min-h-[80px] max-h-[300px]"
                spellCheck={false}
              />
              {parseError && (
                <p className="text-[10px] text-red-500 mt-1">{parseError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="border-t border-border px-4 py-2.5 flex gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-green-700 hover:bg-green-600 text-white rounded-lg transition-colors"
        >
          Approve
        </button>
        <button
          onClick={onReject}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-red-700 hover:bg-red-600 text-white rounded-lg transition-colors"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
