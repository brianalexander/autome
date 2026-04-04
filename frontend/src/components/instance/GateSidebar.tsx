import { useState, useEffect, useCallback } from 'react';
import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import { RunHistory } from './RunHistory';
import type { StageDefinition, StageContext, WorkflowDefinition } from '../../lib/api';

export function GateSidebar({
  stageId,
  stageDef,
  stageCtx,
  definition,
  workflowContext,
  onClose,
  onApprove,
  onReject,
}: {
  stageId: string;
  stageDef: StageDefinition;
  stageCtx: StageContext | null | undefined;
  definition: WorkflowDefinition;
  workflowContext: Record<string, StageContext>;
  onClose: () => void;
  onApprove: (data?: unknown) => void;
  onReject: () => void;
}) {
  const gate = (stageDef.config || {}) as Record<string, unknown>;
  const isWaiting = stageCtx?.status === 'running' && gate.type === 'manual';
  const statusText = stageCtx?.status || 'pending';

  // Find upstream stage(s) by looking at edges targeting this gate
  const upstreamEdges = definition.edges.filter(e => e.target === stageId);
  const upstreamData = (() => {
    if (upstreamEdges.length === 0) return undefined;
    if (upstreamEdges.length === 1) {
      return workflowContext[upstreamEdges[0].source]?.latest;
    }
    // Fan-in: merge upstream outputs keyed by source stage ID
    const merged: Record<string, unknown> = {};
    for (const edge of upstreamEdges) {
      merged[edge.source] = workflowContext[edge.source]?.latest;
    }
    return merged;
  })();

  const [editedData, setEditedData] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);

  // Initialize/reset textarea when upstream data changes
  useEffect(() => {
    if (upstreamData !== undefined) {
      try {
        setEditedData(JSON.stringify(upstreamData, null, 2));
      } catch {
        setEditedData(String(upstreamData));
      }
    }
  }, [upstreamData]);

  const handleApprove = useCallback(() => {
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(editedData);
      setParseError(null);
      onApprove(parsed);
    } catch {
      // Not valid JSON — send as raw string
      if (editedData.trim()) {
        onApprove(editedData);
      } else {
        // Empty — approve without data
        onApprove();
      }
    }
  }, [editedData, onApprove]);

  return (
    <SidebarShell
      title={stageDef.label || stageId}
      subtitle="Gate"
      statusBadge={statusText}
      onClose={onClose}
      onCopyConfig={() => navigator.clipboard.writeText(JSON.stringify(stageDef, null, 2))}
    >
      {gate && (
        <>
          <MetadataRow label="Type" value={String(gate.type || '')} />
          {gate.message && <MetadataRow label="Message" value={String(gate.message)} />}
          {gate.condition && (
            <MetadataRow
              label="Condition"
              value={
                <code className="text-xs text-rose-600 dark:text-rose-300 bg-surface-secondary rounded px-1.5 py-0.5">
                  {String(gate.condition)}
                </code>
              }
            />
          )}
          {gate.timeout_minutes && <MetadataRow label="Timeout" value={`${gate.timeout_minutes} minutes`} />}
          {gate.timeout_action && <MetadataRow label="Timeout Action" value={String(gate.timeout_action)} />}
        </>
      )}
      {stageCtx?.runs?.length && stageCtx.runs[stageCtx.runs.length - 1]?.output && (
        <MetadataRow
          label="Result"
          value={
            stageCtx.runs[stageCtx.runs.length - 1].output.approved ? (
              <span className="text-green-600 dark:text-green-400">Approved</span>
            ) : (
              <span className="text-red-600 dark:text-red-400">Rejected</span>
            )
          }
        />
      )}
      {isWaiting && (
        <>
          {/* Editable data from upstream stage */}
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-text-tertiary uppercase tracking-wider">
                Data to approve
              </span>
              {upstreamEdges.length === 1 && (
                <span className="text-[10px] text-text-muted font-mono">
                  from: {upstreamEdges[0].source}
                </span>
              )}
            </div>
            <textarea
              value={editedData}
              onChange={(e) => {
                const value = e.target.value;
                setEditedData(value);
                if (value.trim()) {
                  try {
                    JSON.parse(value);
                    setParseError(null);
                  } catch {
                    setParseError('Invalid JSON');
                  }
                } else {
                  setParseError(null);
                }
              }}
              className="w-full bg-surface-secondary border border-border-subtle rounded-lg px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-blue-500 resize-y min-h-[100px] max-h-[400px]"
              placeholder="No upstream data available"
              spellCheck={false}
            />
            {parseError && (
              <p className="text-[10px] text-red-500">{parseError}</p>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleApprove}
              className="flex-1 px-3 py-2 text-sm bg-green-700 hover:bg-green-600 text-white rounded"
            >
              Approve
            </button>
            <button
              onClick={onReject}
              className="flex-1 px-3 py-2 text-sm bg-red-700 hover:bg-red-600 text-white rounded"
            >
              Reject
            </button>
          </div>
        </>
      )}
      {stageCtx?.runs && <RunHistory runs={stageCtx.runs} />}
    </SidebarShell>
  );
}
