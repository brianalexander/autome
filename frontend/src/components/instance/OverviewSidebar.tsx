import { StatusBadge } from '../ui/StatusBadge';
import { StageDataCard } from './StageDataCard';
import { EdgeCard } from './EdgeCard';
import { RunningTimer } from '../ui/RunningTimer';
import { formatDuration } from '../../lib/format';
import { getTimelineDotClasses } from '../../lib/statusColors';
import type { WorkflowDefinition, WorkflowInstance, StageContext, StageRun, StageDefinition } from '../../lib/api';

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}

export function OverviewSidebar({
  instance,
  effectiveStatus,
  effectiveContext,
  rawContext,
  workflow,
  isActive,
  instanceId,
  onCancel,
  onClose,
  onCleanup,
}: {
  instance: WorkflowInstance;
  effectiveStatus: string;
  effectiveContext: WorkflowInstance['context'];
  rawContext: WorkflowInstance['context'];
  workflow?: WorkflowDefinition;
  isActive: boolean;
  instanceId: string;
  onCancel: () => void;
  onClose?: () => void;
  onCleanup?: () => void;
}) {
  const stages = effectiveContext.stages as Record<string, StageContext>;
  const rawStages = rawContext.stages as Record<string, StageContext>;
  const stageEntries = Object.entries(stages);

  // Build execution timeline sorted by start time
  const timeline: Array<{
    stageId: string;
    stageDef?: StageDefinition;
    ctx: StageContext;
    run: StageRun;
  }> = [];
  for (const [stageId, ctx] of stageEntries) {
    for (const run of ctx.runs) {
      timeline.push({
        stageId,
        stageDef: workflow?.stages.find((s) => s.id === stageId),
        ctx,
        run,
      });
    }
  }
  timeline.sort((a, b) => new Date(a.run.started_at).getTime() - new Date(b.run.started_at).getTime());

  // Collect all errors from stage runs
  const errors: Array<{ stageId: string; run: StageRun; stageDef?: StageDefinition }> = [];
  for (const [stageId, ctx] of stageEntries) {
    for (const run of ctx.runs) {
      if (run.status === 'failed' && run.error) {
        errors.push({ stageId, run, stageDef: workflow?.stages.find((s) => s.id === stageId) });
      }
    }
  }

  // Detect orphan failure: workflow failed but no stage actually recorded a failed run
  const hasStageErrors = errors.length > 0;
  const stagesStuckRunning = Object.entries(rawStages)
    .filter(([, ctx]) => ctx.status === 'running')
    .map(([id]) => ({ id, def: workflow?.stages.find((s) => s.id === id) }));
  const isOrphanFailure = effectiveStatus === 'failed' && !hasStageErrors && stagesStuckRunning.length > 0;

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      <div className="p-4 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Run Overview</h3>
          {onClose && (
            <button
              onClick={() => {
                onCleanup?.();
                onClose();
              }}
              className="text-[10px] px-2.5 py-1 text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300 border border-red-600/40 dark:border-red-500/40 hover:border-red-500 dark:hover:border-red-400 rounded transition-colors"
            >
              Stop &amp; Close
            </button>
          )}
        </div>
        <p className="text-[10px] text-text-tertiary mt-1">Click a stage on the canvas for details</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Trigger payload */}
        {instance.trigger_event && (
          <div className="p-4 border-b border-border">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">Trigger Payload</div>
            <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-32">
              {typeof instance.trigger_event.payload === 'string'
                ? instance.trigger_event.payload
                : JSON.stringify(instance.trigger_event.payload, null, 2)}
            </pre>
          </div>
        )}

        {/* Orphan failure — workflow failed but no stage recorded an error */}
        {isOrphanFailure && (
          <div className="p-4 border-b border-border">
            <div className="bg-status-error-muted border border-red-300 dark:border-red-500/30 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <div className="text-sm font-medium text-red-600 dark:text-red-400">Workflow Failed</div>
              </div>
              <div className="text-xs text-red-600 dark:text-red-400/80 mb-3">
                The workflow crashed before the running stage{stagesStuckRunning.length > 1 ? 's' : ''} could report
                results. This typically means the agent process failed to start or lost connection.
              </div>
              <div className="space-y-1">
                {stagesStuckRunning.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-xs">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
                    <span className="font-mono text-red-600 dark:text-red-300">{s.def?.label || s.id}</span>
                    <span className="text-text-muted">- stuck in running state</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Errors section — prominent if any exist */}
        {errors.length > 0 && (
          <div className="p-4 border-b border-border">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <div className="text-xs font-medium text-red-600 dark:text-red-400">
                {errors.length} Error{errors.length > 1 ? 's' : ''}
              </div>
            </div>
            <div className="space-y-2">
              {errors.map((err, i) => (
                <div
                  key={i}
                  className="bg-status-error-muted border border-red-300 dark:border-red-500/30 rounded-lg p-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-red-600 dark:text-red-300">
                      {err.stageDef?.label || err.stageId}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {err.run.completed_at ? formatTimestamp(err.run.completed_at) : ''}
                    </span>
                  </div>
                  <pre className="text-[11px] font-mono text-red-600 dark:text-red-400/90 bg-status-error-muted rounded p-2 overflow-x-auto max-h-48 whitespace-pre">{err.run.error}</pre>
                  {err.run.started_at && err.run.completed_at && (
                    <div className="text-[10px] text-text-muted mt-1">
                      Duration: {formatDuration(err.run.started_at, err.run.completed_at)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stage execution timeline */}
        <div className="p-4 border-b border-border">
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">Execution Timeline</div>
          {timeline.length === 0 ? (
            <div className="text-xs text-text-muted text-center py-4">
              {effectiveStatus === 'running' ? 'Waiting for stages to start...' : 'No stages executed'}
            </div>
          ) : (
            <div className="space-y-1">
              {timeline.map((entry, i) => {
                const { dot: statusColor, line: lineColor } = getTimelineDotClasses(entry.run.status);

                return (
                  <div key={`${entry.stageId}-${entry.run.iteration}`} className="flex gap-3">
                    {/* Timeline line */}
                    <div className="flex flex-col items-center w-3 flex-shrink-0">
                      <div
                        className={`w-2.5 h-2.5 rounded-full border-2 ${statusColor} ${entry.run.status === 'running' ? 'animate-pulse' : ''}`}
                      />
                      {i < timeline.length - 1 && <div className={`w-0.5 flex-1 ${lineColor} min-h-[16px]`} />}
                    </div>
                    {/* Content */}
                    <div className="flex-1 pb-3 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono text-text-primary truncate">
                          {entry.stageDef?.label || entry.stageId}
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {entry.run.started_at && entry.run.completed_at ? (
                            <span className="text-[10px] text-text-muted">
                              {formatDuration(entry.run.started_at, entry.run.completed_at)}
                            </span>
                          ) : entry.run.status === 'running' && entry.run.started_at ? (
                            <RunningTimer
                              startedAt={entry.run.started_at}
                              className="text-[10px] text-blue-400 font-mono tabular-nums"
                            />
                          ) : null}
                          <StatusBadge status={entry.run.status} />
                        </div>
                      </div>
                      {/* Show output summary for completed stages */}
                      {entry.run.status === 'completed' && entry.run.output && (
                        <div className="mt-1 text-[10px] text-text-tertiary truncate">
                          Output:{' '}
                          {JSON.stringify(entry.run.output).slice(0, 120)}
                        </div>
                      )}
                      {/* Show error for failed stages */}
                      {entry.run.status === 'failed' && entry.run.error && (
                        <pre className="mt-1 text-[10px] font-mono text-red-600 dark:text-red-400 overflow-x-auto max-h-20 whitespace-pre">{entry.run.error}</pre>
                      )}
                      <div className="text-[10px] text-text-muted">{formatTimestamp(entry.run.started_at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Stage data flow — inputs/outputs for each stage */}
        <div className="p-4 border-b border-border">
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">Stage Data</div>
          <div className="space-y-2">
            {(workflow?.stages || [])
              .slice()
              .sort((a, b) => {
                // Sort by execution start time (earliest first), pending stages last
                const aStart = stages[a.id]?.runs?.[0]?.started_at;
                const bStart = stages[b.id]?.runs?.[0]?.started_at;
                if (!aStart && !bStart) return 0;
                if (!aStart) return 1;
                if (!bStart) return -1;
                return new Date(aStart).getTime() - new Date(bStart).getTime();
              })
              .map((stage) => {
                const ctx = stages[stage.id];
                if (!ctx) return null;
                const latestRun = ctx.runs?.[ctx.runs.length - 1];
                const hasOutput = ctx.latest || latestRun?.output;
                const hasError = latestRun?.status === 'failed' && latestRun.error;

                return (
                  <StageDataCard
                    key={stage.id}
                    stageId={stage.id}
                    stageName={stage.label}
                    status={ctx.status}
                    output={ctx.latest || latestRun?.output}
                    error={hasError ? latestRun.error : undefined}
                    runCount={ctx.run_count}
                  />
                );
              })}
          </div>
        </div>

        {/* Edge definitions */}
        {workflow && workflow.edges.length > 0 && (
          <div className="p-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">Edges</div>
            <div className="space-y-2">
              {workflow.edges.map((edge) => {
                const sourceDef = workflow.stages.find((s) => s.id === edge.source);
                const targetDef = workflow.stages.find((s) => s.id === edge.target);
                return (
                  <EdgeCard
                    key={edge.id}
                    edge={edge}
                    sourceName={sourceDef?.label || edge.source}
                    targetName={targetDef?.label || edge.target}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
