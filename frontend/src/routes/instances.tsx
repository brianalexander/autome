import { createFileRoute, Link, Outlet, useMatch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Activity } from 'lucide-react';
import { useInstances, useWorkflows, useCancelInstance, useDeleteInstance } from '../hooks/queries';
import { isTriggerType, type WorkflowInstance, type WorkflowDefinition } from '../lib/api';
import { useMemo } from 'react';

export const Route = createFileRoute('/instances')({
  component: InstancesLayout,
});

const statusDot: Record<string, string> = {
  running: 'bg-blue-400',
  waiting_gate: 'bg-amber-400',
  waiting_input: 'bg-amber-400',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  cancelled: 'bg-text-muted',
};

const statusText: Record<string, string> = {
  running: 'text-blue-600 dark:text-blue-400',
  waiting_gate: 'text-amber-600 dark:text-amber-400',
  waiting_input: 'text-amber-600 dark:text-amber-400',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  cancelled: 'text-text-tertiary',
};

function InstancesLayout() {
  const childMatch = useMatch({ from: '/instances/$instanceId', shouldThrow: false });
  if (childMatch) return <Outlet />;
  return <InstancesList />;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function InstancesList() {
  const { data: instanceList, isLoading, error } = useInstances();
  const { data: workflowList } = useWorkflows();

  const cancelInstance = useCancelInstance();
  const deleteInstance = useDeleteInstance();

  // Build workflow name lookup
  const workflowMap = useMemo(() => {
    const map = new Map<string, WorkflowDefinition>();
    for (const p of workflowList?.data || []) map.set(p.id, p);
    return map;
  }, [workflowList]);

  // Group instances by workflow
  const grouped = useMemo(() => {
    const instanceData = instanceList?.data;
    if (!instanceData?.length) return [];
    const groups = new Map<string, { workflow: WorkflowDefinition | undefined; instances: WorkflowInstance[] }>();
    for (const inst of instanceData) {
      const key = inst.definition_id;
      if (!groups.has(key)) {
        groups.set(key, { workflow: workflowMap.get(key), instances: [] });
      }
      groups.get(key)!.instances.push(inst);
    }
    // Sort groups: most recent instance first
    return Array.from(groups.values()).sort((a, b) => {
      const aTime = new Date(a.instances[0].created_at).getTime();
      const bTime = new Date(b.instances[0].created_at).getTime();
      return bTime - aTime;
    });
  }, [instanceList, workflowMap]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-text-muted text-sm">Loading instances...</span>
      </div>
    );
  }
  if (error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;

  if (grouped.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Activity className="w-12 h-12 text-text-muted/30 mx-auto mb-3" />
          <p className="text-text-secondary text-sm">No instances yet</p>
          <p className="text-text-muted text-xs mt-1">Trigger a workflow to see runs here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      {(
        <div className="space-y-6">
          {grouped.map(({ workflow, instances }) => (
            <div key={instances[0].definition_id}>
              {/* Workflow group header */}
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-medium text-text-primary">{workflow?.name || 'Deleted workflow'}</h3>
                <span className="text-[10px] text-text-muted">
                  {instances.length} run{instances.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Instance rows — compact table-like layout */}
              <div className="border border-border rounded-lg overflow-hidden divide-y divide-border/50">
                {instances.map((inst) => {
                  const stageEntries = inst.context?.stages ? Object.entries(inst.context.stages) : [];
                  // Count trigger stages as completed (if instance exists, trigger succeeded)
                  const triggerCount = workflow?.stages.filter((s) => isTriggerType(s.type)).length || 0;
                  const completed = stageEntries.filter(([, s]) => s.status === 'completed').length + triggerCount;
                  const total = stageEntries.length + triggerCount;
                  const triggerPrompt = inst.trigger_event?.payload?.prompt;

                  return (
                    <Link
                      key={inst.id}
                      to="/instances/$instanceId"
                      params={{ instanceId: inst.id }}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-interactive transition-colors group/row"
                    >
                      {/* Status dot */}
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot[inst.status] || 'bg-text-muted'}`}
                      />

                      {/* Main info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium ${statusText[inst.status] || 'text-text-secondary'}`}>
                            {inst.status}
                          </span>
                          {triggerPrompt && (
                            <span className="text-xs text-text-tertiary truncate">
                              {triggerPrompt.length > 60 ? triggerPrompt.slice(0, 60) + '...' : triggerPrompt}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Stage progress */}
                      {total > 0 && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <div className="flex gap-px">
                            {/* Trigger stages — always green */}
                            {Array.from({ length: triggerCount }).map((_, i) => (
                              <div key={`trigger-${i}`} className="w-1.5 h-3 rounded-sm bg-teal-500" />
                            ))}
                            {stageEntries.map(([id, s]) => (
                              <div
                                key={id}
                                className={`w-1.5 h-3 rounded-sm ${
                                  s.status === 'completed'
                                    ? 'bg-green-500'
                                    : s.status === 'running'
                                      ? 'bg-blue-500'
                                      : s.status === 'failed'
                                        ? 'bg-red-500'
                                        : 'bg-border-subtle'
                                }`}
                              />
                            ))}
                          </div>
                          <span className="text-[10px] text-text-muted ml-1">
                            {completed}/{total}
                          </span>
                        </div>
                      )}

                      {/* Actions — always visible, fixed width */}
                      <div className="flex items-center gap-1 flex-shrink-0 w-24 justify-end">
                        {(inst.status === 'running' ||
                          inst.status === 'waiting_gate' ||
                          inst.status === 'waiting_input') && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              cancelInstance.mutate(inst.id);
                            }}
                            className="text-[10px] text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 px-1.5 py-0.5 rounded hover:bg-amber-50 dark:hover:bg-amber-900/30"
                            title="Cancel run"
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (confirm('Delete this run?')) {
                              deleteInstance.mutate(inst.id, {
                                onSuccess: () => toast.success('Run deleted'),
                              });
                            }
                          }}
                          className="text-[10px] text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30"
                          title="Delete run"
                        >
                          Delete
                        </button>
                      </div>

                      {/* Timestamp */}
                      <span className="text-[10px] text-text-muted flex-shrink-0 w-14 text-right">
                        {timeAgo(inst.created_at)}
                      </span>

                      {/* ID */}
                      <span className="font-mono text-[10px] text-text-muted flex-shrink-0 w-16 text-right">
                        {inst.id.slice(0, 8)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
