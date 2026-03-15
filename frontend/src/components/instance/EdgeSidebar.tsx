import { SidebarShell } from '../ui/SidebarShell';
import { MetadataRow } from '../ui/MetadataRow';
import type { EdgeDefinition, WorkflowDefinition } from '../../lib/api';

export function EdgeSidebar({
  edge,
  workflow,
  onClose,
}: {
  edge?: EdgeDefinition;
  workflow: WorkflowDefinition;
  onClose: () => void;
}) {
  if (!edge)
    return (
      <SidebarShell title="Edge Not Found" onClose={onClose} onCopyConfig={undefined}>
        <div className="text-sm text-text-tertiary">Edge definition not found.</div>
      </SidebarShell>
    );

  const sourceDef = workflow.stages.find((s) => s.id === edge.source);
  const targetDef = workflow.stages.find((s) => s.id === edge.target);

  return (
    <SidebarShell
      title={edge.label || `${sourceDef?.label || edge.source} \u2192 ${targetDef?.label || edge.target}`}
      subtitle="Edge"
      onClose={onClose}
      onCopyConfig={() => navigator.clipboard.writeText(JSON.stringify(edge, null, 2))}
    >
      <MetadataRow
        label="Source"
        value={<span className="font-mono text-xs">{sourceDef?.label || edge.source}</span>}
      />
      <MetadataRow
        label="Target"
        value={<span className="font-mono text-xs">{targetDef?.label || edge.target}</span>}
      />
      {edge.condition && (
        <div>
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Condition</div>
          <code className="text-xs text-rose-600 dark:text-rose-300 bg-surface-secondary rounded px-2 py-1.5 block overflow-x-auto">
            {edge.condition}
          </code>
        </div>
      )}
      {edge.prompt_template && (
        <div>
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">Prompt Template</div>
          <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
            {edge.prompt_template}
          </pre>
        </div>
      )}
      {edge.max_traversals != null && <MetadataRow label="Max Traversals" value={String(edge.max_traversals)} />}
    </SidebarShell>
  );
}
