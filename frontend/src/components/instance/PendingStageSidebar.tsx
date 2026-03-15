import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import type { StageDefinition } from '../../lib/api';

export function PendingStageSidebar({
  stageId,
  stageDef,
  onClose,
}: {
  stageId: string;
  stageDef?: StageDefinition;
  onClose: () => void;
}) {
  return (
    <SidebarShell
      title={stageDef?.label || stageId}
      subtitle={stageDef?.type || 'stage'}
      statusBadge="pending"
      onClose={onClose}
      onCopyConfig={stageDef ? () => navigator.clipboard.writeText(JSON.stringify(stageDef, null, 2)) : undefined}
    >
      {stageDef?.type === 'agent' && stageDef.config && (
        <>
          <MetadataRow label="Agent" value={(stageDef.config as Record<string, unknown>)?.agentId as string} />
          {(stageDef.config as Record<string, unknown>)?.max_iterations && (
            <MetadataRow label="Max Iterations" value={(stageDef.config as Record<string, unknown>).max_iterations as number} />
          )}
          {(stageDef.config as Record<string, unknown>)?.timeout_minutes && (
            <MetadataRow label="Timeout" value={`${(stageDef.config as Record<string, unknown>).timeout_minutes} min`} />
          )}
        </>
      )}
      <div className="text-sm text-text-tertiary py-4 text-center">Waiting for upstream stages to complete.</div>
    </SidebarShell>
  );
}
