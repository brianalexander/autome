import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import { RunHistory } from './RunHistory';
import type { StageDefinition, StageContext } from '../../lib/api';

export function GateSidebar({
  stageId,
  stageDef,
  stageCtx,
  onClose,
  onApprove,
  onReject,
}: {
  stageId: string;
  stageDef: StageDefinition;
  stageCtx: StageContext | null | undefined;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const gate = (stageDef.config || {}) as Record<string, unknown>;
  const isWaiting = stageCtx?.status === 'running' && gate.type === 'manual';
  const statusText = stageCtx?.status || 'pending';

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
      {stageCtx?.runs?.[0]?.output && (
        <MetadataRow
          label="Result"
          value={
            stageCtx.runs[0].output.approved ? (
              <span className="text-green-600 dark:text-green-400">Approved</span>
            ) : (
              <span className="text-red-600 dark:text-red-400">Rejected</span>
            )
          }
        />
      )}
      {isWaiting && (
        <div className="flex gap-2 pt-2">
          <button
            onClick={onApprove}
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
      )}
      {stageCtx?.runs && <RunHistory runs={stageCtx.runs} />}
    </SidebarShell>
  );
}
