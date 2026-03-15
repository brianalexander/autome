import { createFileRoute } from '@tanstack/react-router';
import {
  useInstance,
  useInstanceStatus,
  useWorkflow,
  useInstanceDefinition,
  useCancelInstance,
} from '../hooks/queries';
import { RuntimeViewer } from '../components/instance/RuntimeViewer';
import { formatDuration } from '../lib/format';
import { isTriggerType } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

export const Route = createFileRoute('/instances/$instanceId')({
  component: InstanceDetail,
});

function InstanceDetail() {
  const { instanceId } = Route.useParams();
  // Subscribe to instance-scoped events so the server only sends relevant updates
  useWebSocket([`instance:${instanceId}`]);
  const { data: instance, isLoading: instanceLoading } = useInstance(instanceId);
  const { data: liveStatus } = useInstanceStatus(instanceId);
  // Fetch the definition for this instance's version; fall back to live workflow
  const { data: versionedDef } = useInstanceDefinition(instanceId);
  const { data: liveWorkflow } = useWorkflow(instance?.definition_id || '');
  const workflow = versionedDef ?? liveWorkflow;
  const cancelInstance = useCancelInstance();

  if (instanceLoading) return <div className="p-6 text-text-secondary">Loading...</div>;
  if (!instance) return <div className="p-6 text-text-secondary">Instance not found</div>;

  const effectiveStatus = liveStatus?.status ?? instance.status;
  const effectiveContext = liveStatus?.context ?? instance.context;

  const stages = effectiveContext.stages ?? {};
  const stageIds = Object.keys(stages);
  const triggerCount = workflow?.stages.filter((s) => isTriggerType(s.type)).length || 0;
  const totalCount = stageIds.length + triggerCount;
  const completedCount = stageIds.filter((id) => stages[id].status === 'completed').length + triggerCount;
  const isActive =
    effectiveStatus === 'running' || effectiveStatus === 'waiting_gate' || effectiveStatus === 'waiting_input';

  // Build version info string
  const versionInfo =
    instance.definition_version != null
      ? liveWorkflow?.version != null && liveWorkflow.version !== instance.definition_version
        ? `v${instance.definition_version} (current: v${liveWorkflow.version})`
        : `v${instance.definition_version}`
      : undefined;

  // Build stage progress string
  const stageProgress = totalCount > 0 ? `${completedCount}/${totalCount} completed` : undefined;

  // Build duration string
  const duration = instance.completed_at
    ? formatDuration(instance.created_at, instance.completed_at)
    : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Canvas + sidebar via RuntimeViewer — header replaced by floating widgets */}
      {workflow ? (
        <RuntimeViewer
          instanceId={instanceId}
          definition={workflow}
          instance={instance}
          liveStatus={liveStatus}
          workflowName={workflow.name}
          workflowDescription={workflow.description}
          workflowId={workflow.id}
          effectiveStatus={effectiveStatus}
          versionInfo={versionInfo}
          stageProgress={stageProgress}
          duration={duration}
          isActive={isActive}
          onCancel={() => cancelInstance.mutate(instanceId)}
          cancelPending={cancelInstance.isPending}
        />
      ) : (
        <div className="p-6 text-text-tertiary">Loading workflow definition...</div>
      )}
    </div>
  );
}
