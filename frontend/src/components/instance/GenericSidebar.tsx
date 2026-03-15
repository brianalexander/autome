import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import { ReadOnlySchemaView } from '../ui/ReadOnlySchemaView';
import { RunHistory } from './RunHistory';
import { useNodeTypes } from '../../hooks/queries';
import type { StageDefinition, StageContext } from '../../lib/api';

export function GenericSidebar({
  stageId,
  stageDef,
  stageCtx,
  onClose,
}: {
  stageId: string;
  stageDef?: StageDefinition;
  stageCtx: StageContext | null | undefined;
  onClose: () => void;
}) {
  const { data: nodeTypeList } = useNodeTypes();

  const nodeType = nodeTypeList?.find((nt) => nt.id === stageDef?.type);
  const configSchema = nodeType?.configSchema as Record<string, unknown> | undefined;
  const hasSchema =
    configSchema &&
    configSchema.properties &&
    Object.keys(configSchema.properties as object).length > 0;

  const handleCopyConfig = () => {
    if (stageDef) {
      navigator.clipboard.writeText(JSON.stringify(stageDef, null, 2));
    }
  };

  return (
    <SidebarShell
      title={stageDef?.label || stageId}
      subtitle={stageDef?.type || 'unknown'}
      statusBadge={stageCtx?.status || 'pending'}
      onClose={onClose}
      onCopyConfig={stageDef ? handleCopyConfig : undefined}
    >
      {stageDef && (
        <>
          {stageDef.description && <MetadataRow label="Description" value={stageDef.description} />}

          {/* Map Over section — shown when map_over is set */}
          {stageDef.map_over && (
            <div className="rounded-lg border border-indigo-400/40 bg-indigo-500/10 p-3 space-y-2">
              <div className="text-[10px] text-indigo-400 uppercase tracking-wider font-semibold">Map Over</div>
              <div>
                <div className="text-[10px] text-text-tertiary mb-0.5">Expression</div>
                <code className="text-xs text-indigo-300 bg-indigo-500/10 rounded px-1.5 py-0.5 font-mono block break-all">
                  {stageDef.map_over}
                </code>
              </div>
              {stageDef.concurrency != null && (
                <div className="flex gap-4">
                  <div>
                    <div className="text-[10px] text-text-tertiary mb-0.5">Concurrency</div>
                    <span className="text-xs text-text-primary font-mono">{stageDef.concurrency}</span>
                  </div>
                  {stageDef.failure_tolerance != null && (
                    <div>
                      <div className="text-[10px] text-text-tertiary mb-0.5">Failure Tolerance</div>
                      <span className="text-xs text-text-primary font-mono">{stageDef.failure_tolerance}</span>
                    </div>
                  )}
                </div>
              )}
              {stageDef.concurrency == null && stageDef.failure_tolerance != null && (
                <div>
                  <div className="text-[10px] text-text-tertiary mb-0.5">Failure Tolerance</div>
                  <span className="text-xs text-text-primary font-mono">{stageDef.failure_tolerance}</span>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">Configuration</div>
            {hasSchema ? (
              <ReadOnlySchemaView
                schema={configSchema}
                values={(stageDef.config as Record<string, unknown>) || {}}
              />
            ) : stageDef.config && Object.keys(stageDef.config).length > 0 ? (
              <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(stageDef.config, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-text-tertiary py-2">No configuration needed.</div>
            )}
          </div>
        </>
      )}
      {stageCtx?.runs && <RunHistory runs={stageCtx.runs} />}
    </SidebarShell>
  );
}
