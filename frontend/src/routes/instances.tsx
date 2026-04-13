import { createFileRoute, Link, Outlet, useMatch, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Activity, ChevronDown } from 'lucide-react';
import { z } from 'zod';
import { useInstances, useWorkflows, useCancelInstance, useDeleteInstance } from '../hooks/queries';
import { isTriggerType, type WorkflowInstance, type WorkflowDefinition } from '../lib/api';
import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { StatusBadge } from '../components/ui/StatusBadge';
import { formatDuration } from '../lib/format';

const PAGE_SIZE = 50;

const instancesSearchSchema = z.object({
  status: z.string().optional(),
  definitionId: z.string().optional(),
  offset: z.number().optional(),
});

export const Route = createFileRoute('/instances')({
  component: InstancesLayout,
  validateSearch: instancesSearchSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatAbsDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function instanceDuration(inst: WorkflowInstance): string {
  if (inst.completed_at) {
    return formatDuration(inst.created_at, inst.completed_at);
  }
  // Still running — show elapsed
  const ms = Date.now() - new Date(inst.created_at).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function getFailedStageName(inst: WorkflowInstance, workflow: WorkflowDefinition | undefined): string | undefined {
  if (inst.status !== 'failed') return undefined;
  const stages = inst.context?.stages ?? {};
  const failedId = Object.entries(stages).find(([, s]) => s.status === 'failed')?.[0];
  if (!failedId) return undefined;
  const stageDef = workflow?.stages.find((s) => s.id === failedId);
  return stageDef?.label || stageDef?.id || failedId;
}

const initiatedByColors: Record<string, string> = {
  user: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300',
  author: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300',
  webhook: 'bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-300',
  cron: 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-300',
};

// ---------------------------------------------------------------------------
// Status chip filter
// ---------------------------------------------------------------------------

type StatusFilter = '' | 'running' | 'waiting_gate' | 'failed' | 'completed' | 'cancelled';

const STATUS_CHIPS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: '' },
  { label: 'Running', value: 'running' },
  { label: 'Waiting', value: 'waiting_gate' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

// ---------------------------------------------------------------------------
// Route layout
// ---------------------------------------------------------------------------

function InstancesLayout() {
  const childMatch = useMatch({ from: '/instances/$instanceId', shouldThrow: false });
  if (childMatch) return <Outlet />;
  return <InstancesList />;
}

// ---------------------------------------------------------------------------
// Workflow dropdown
// ---------------------------------------------------------------------------

function WorkflowDropdown({
  workflows,
  selected,
  onSelect,
}: {
  workflows: WorkflowDefinition[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
  }, []);

  useEffect(() => {
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  const selectedName = selected ? (workflows.find((w) => w.id === selected)?.name ?? 'Unknown') : 'All Workflows';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-text-secondary hover:text-text-primary hover:border-border-subtle transition-colors"
      >
        <span className="max-w-[180px] truncate">{selectedName}</span>
        <ChevronDown size={12} className="opacity-50 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 min-w-[200px] max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          <button
            onClick={() => { onSelect(''); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-xs transition-colors ${
              selected === ''
                ? 'bg-surface-tertiary text-text-primary font-medium'
                : 'text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
            }`}
          >
            All Workflows
          </button>
          {workflows.map((w) => (
            <button
              key={w.id}
              onClick={() => { onSelect(w.id); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs transition-colors truncate ${
                selected === w.id
                  ? 'bg-surface-tertiary text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
              }`}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main list
// ---------------------------------------------------------------------------

function InstancesList() {
  const navigate = useNavigate({ from: '/instances' });
  const search = Route.useSearch();
  const statusFilter = (search.status ?? '') as StatusFilter;
  const definitionId = search.definitionId ?? '';
  const offset = search.offset ?? 0;

  const filter = useMemo(() => ({
    status: statusFilter || undefined,
    definitionId: definitionId || undefined,
    limit: PAGE_SIZE,
    offset,
  }), [statusFilter, definitionId, offset]);

  const { data: instanceList, isLoading, error } = useInstances(filter);
  const { data: workflowList } = useWorkflows();

  const cancelInstance = useCancelInstance();
  const deleteInstance = useDeleteInstance();

  // Build workflow name lookup
  const workflowMap = useMemo(() => {
    const map = new Map<string, WorkflowDefinition>();
    for (const p of workflowList?.data || []) map.set(p.id, p);
    return map;
  }, [workflowList]);

  // Filter out test runs client-side (API may not support is_test param)
  const instances = useMemo(
    () => (instanceList?.data || []).filter((inst) => !inst.is_test),
    [instanceList],
  );

  const total = instanceList?.total ?? 0;

  function setStatus(value: StatusFilter) {
    navigate({ search: (prev) => ({ ...prev, status: value || undefined, offset: undefined }) });
  }

  function setDefinitionId(id: string) {
    navigate({ search: (prev) => ({ ...prev, definitionId: id || undefined, offset: undefined }) });
  }

  function setOffset(n: number) {
    navigate({ search: (prev) => ({ ...prev, offset: n || undefined }) });
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-text-muted text-sm">Loading instances...</span>
      </div>
    );
  }
  if (error) {
    return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filters bar */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-border flex flex-wrap items-center gap-3">
        {/* Status chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_CHIPS.map(({ label, value }) => {
            const isActive = statusFilter === value;
            return (
              <button
                key={value || 'all'}
                onClick={() => setStatus(value)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'bg-surface-tertiary text-text-secondary hover:bg-surface-secondary hover:text-text-primary'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="w-px h-4 bg-border flex-shrink-0" />

        {/* Workflow filter */}
        <WorkflowDropdown
          workflows={workflowList?.data ?? []}
          selected={definitionId}
          onSelect={setDefinitionId}
        />

        {/* Total count */}
        {total > 0 && (
          <span className="ml-auto text-xs text-text-muted flex-shrink-0">
            {total} run{total !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {instances.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center py-16">
              <Activity className="w-10 h-10 text-text-muted/30 mx-auto mb-3" />
              <p className="text-text-secondary text-sm">No instances match your filters</p>
              <p className="text-text-muted text-xs mt-1">Try adjusting the status or workflow filter</p>
              {(statusFilter || definitionId) && (
                <button
                  onClick={() => navigate({ search: {} })}
                  className="mt-4 text-xs text-blue-500 hover:text-blue-400 underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-1">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 px-3 pb-1 text-[10px] text-text-muted uppercase tracking-wide">
              <span>Workflow / Run</span>
              <span className="w-24 text-center">Status</span>
              <span className="w-20 text-right">Duration</span>
              <span className="w-16 text-right">Initiated</span>
              <span className="w-20 text-right">Created</span>
              <span className="w-24 text-right">Actions</span>
            </div>

            {/* Instance rows */}
            <div className="border border-border rounded-lg overflow-hidden divide-y divide-border/50">
              {instances.map((inst) => {
                const workflow = inst.definition_id ? workflowMap.get(inst.definition_id) : undefined;
                const failedStage = getFailedStageName(inst, workflow);

                const stageEntries = inst.context?.stages ? Object.entries(inst.context.stages) : [];
                const triggerCount = workflow?.stages.filter((s) => isTriggerType(s.type)).length || 0;
                const completed = stageEntries.filter(([, s]) => s.status === 'completed').length + triggerCount;
                const total = stageEntries.length + triggerCount;

                const isActive =
                  inst.status === 'running' ||
                  inst.status === 'waiting_gate' ||
                  inst.status === 'waiting_input';

                return (
                  <Link
                    key={inst.id}
                    to="/instances/$instanceId"
                    params={{ instanceId: inst.id }}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 items-center px-3 py-2.5 hover:bg-interactive transition-colors group/row"
                  >
                    {/* Workflow name + run details */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-text-primary truncate">
                          {workflow?.name ?? (inst.definition_id ? 'Deleted workflow' : 'Unknown workflow')}
                        </span>
                        {failedStage && (
                          <span className="flex-shrink-0 text-[10px] text-status-error bg-status-error-muted px-1.5 py-0.5 rounded">
                            failed: {failedStage}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-[10px] text-text-muted">{inst.id.slice(0, 8)}</span>
                        {/* Stage progress mini bar */}
                        {total > 0 && (
                          <div className="flex items-center gap-0.5">
                            <div className="flex gap-px">
                              {Array.from({ length: triggerCount }).map((_, i) => (
                                <div key={`trig-${i}`} className="w-1 h-2 rounded-sm bg-teal-500" />
                              ))}
                              {stageEntries.map(([id, s]) => (
                                <div
                                  key={id}
                                  className={`w-1 h-2 rounded-sm ${
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
                            <span className="text-[10px] text-text-muted ml-0.5">
                              {completed}/{total}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Status badge */}
                    <div className="w-24 flex justify-center">
                      <StatusBadge status={inst.status} />
                    </div>

                    {/* Duration */}
                    <div className="w-20 text-right">
                      <span className="text-[10px] text-text-muted tabular-nums">
                        {instanceDuration(inst)}
                      </span>
                    </div>

                    {/* Initiated by */}
                    <div className="w-16 flex justify-end">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${initiatedByColors[inst.initiated_by] ?? 'bg-surface-tertiary text-text-muted'}`}
                      >
                        {inst.initiated_by}
                      </span>
                    </div>

                    {/* Created time */}
                    <div className="w-20 text-right" title={formatAbsDate(inst.created_at)}>
                      <span className="text-[10px] text-text-muted tabular-nums">
                        {timeAgo(inst.created_at)}
                      </span>
                    </div>

                    {/* Actions */}
                    <div
                      className="w-24 flex items-center gap-1 justify-end"
                      onClick={(e) => e.preventDefault()}
                    >
                      {isActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelInstance.mutate(inst.id);
                          }}
                          className="text-[10px] text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 px-1.5 py-0.5 rounded hover:bg-amber-50 dark:hover:bg-amber-900/30"
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('Delete this run?')) {
                            deleteInstance.mutate(inst.id, {
                              onSuccess: () => toast.success('Run deleted'),
                            });
                          }
                        }}
                        className="text-[10px] text-text-muted hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30"
                      >
                        Delete
                      </button>
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="pt-3 flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  Showing {offset + 1}–{Math.min(offset + instances.length, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    className="px-3 py-1.5 text-xs border border-border rounded-lg text-text-secondary disabled:opacity-40 hover:bg-interactive transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    className="px-3 py-1.5 text-xs border border-border rounded-lg text-text-secondary disabled:opacity-40 hover:bg-interactive transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
