import { useState, useMemo, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useApproveGate, useRejectGate, useCancelInstance, useResumeInstance } from '../../hooks/queries';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { AgentSessionViewer } from '../session/AgentSessionViewer';
import { ResizablePanel } from '../ui/ResizablePanel';
import { OverviewSidebar } from './OverviewSidebar';
import { EdgeSidebar } from './EdgeSidebar';
import { TriggerSidebar } from './TriggerSidebar';
import { GateSidebar } from './GateSidebar';
import { PendingStageSidebar } from './PendingStageSidebar';
import { GenericSidebar } from './GenericSidebar';
import { InstanceInfoBubble } from './InstanceInfoBubble';
import {
  isTriggerType,
  type WorkflowDefinition,
  type WorkflowInstance,
  type StageContext,
} from '../../lib/api';

export { StatusBadge } from '../ui/StatusBadge';

// --- Props ---

export interface RuntimeViewerProps {
  instanceId: string;
  definition: WorkflowDefinition;
  instance: WorkflowInstance;
  liveStatus?: { status: string; context: WorkflowInstance['context'] } | null;
  onClose?: () => void;
  onCleanup?: () => void;
  // Floating widget props
  workflowName?: string;
  workflowDescription?: string;
  workflowId?: string;
  effectiveStatus?: string;
  versionInfo?: string;
  stageProgress?: string;
  duration?: string | null;
  isActive?: boolean;
  onCancel?: () => void;
  cancelPending?: boolean;
  initialStageId?: string;
}

// --- Main component ---

export function RuntimeViewer({
  instanceId,
  definition,
  instance,
  liveStatus,
  onClose,
  onCleanup,
  workflowName,
  workflowDescription,
  workflowId,
  effectiveStatus: effectiveStatusProp,
  versionInfo,
  stageProgress,
  duration,
  isActive: isActiveProp,
  onCancel,
  cancelPending,
  initialStageId,
}: RuntimeViewerProps) {
  const approveGate = useApproveGate();
  const rejectGate = useRejectGate();
  const cancelInstance = useCancelInstance();
  const resumeInstance = useResumeInstance();

  const [selectedStageId, setSelectedStageId] = useState<string | null>(initialStageId ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Sync when a deep-link stageId arrives after initial mount
  useEffect(() => {
    if (initialStageId && initialStageId !== selectedStageId) {
      setSelectedStageId(initialStageId);
    }
  }, [initialStageId]);

  const rawContext = liveStatus?.context ?? instance.context;
  const internalEffectiveStatus = liveStatus?.status ?? instance.status;
  // Prefer the prop value (computed by the route) when provided, fall back to internal
  const effectiveStatus = effectiveStatusProp ?? internalEffectiveStatus;

  // Fix up stage statuses: if workflow failed but stages are stuck as "running",
  // mark them as "failed" for display purposes so the canvas shows the right colors
  const effectiveContext = useMemo(() => {
    const ctx = structuredClone(rawContext);
    if (effectiveStatus === 'failed') {
      for (const sctx of Object.values(ctx.stages as Record<string, StageContext>)) {
        if (sctx.status === 'running') {
          sctx.status = 'failed';
        }
      }
    }
    return ctx;
  }, [rawContext, effectiveStatus]);

  const stages = effectiveContext.stages as Record<string, StageContext>;
  const isActive =
    isActiveProp ??
    (effectiveStatus === 'running' || effectiveStatus === 'waiting_gate' || effectiveStatus === 'waiting_input');

  // Determine what kind of node is selected
  const selectedStageDef = selectedStageId ? definition.stages.find((s) => s.id === selectedStageId) : undefined;
  const isTriggerSelected = selectedStageDef ? isTriggerType(selectedStageDef.type) : false;
  const selectedStageCtx = selectedStageId && !isTriggerSelected ? stages[selectedStageId] : null;

  const handleStageClick = (id: string | null) => {
    setSelectedStageId(id);
    setSelectedEdgeId(null);
  };

  const handleEdgeClick = (id: string | null) => {
    setSelectedEdgeId(id);
    setSelectedStageId(null);
  };

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      {/* Canvas */}
      <div className="flex-1 overflow-hidden relative">
        {/* Floating widget: instance info — top-left of canvas */}
        <InstanceInfoBubble
          workflowName={workflowName}
          workflowDescription={workflowDescription}
          effectiveStatus={effectiveStatus}
          versionInfo={versionInfo}
          stageProgress={stageProgress}
          duration={duration}
          onBack={onClose}
        />

        {/* Floating widget: actions — top-right of canvas */}
        <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
          {workflowId && (
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId }}
              className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] shadow-sm backdrop-blur-sm transition-colors"
            >
              View Workflow
            </Link>
          )}
          {onClose && !workflowId && (
            <button
              onClick={onClose}
              className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] shadow-sm backdrop-blur-sm transition-colors"
            >
              Close
            </button>
          )}
          {isActive && (
            <button
              onClick={onCancel ?? (() => cancelInstance.mutate(instanceId))}
              disabled={cancelPending ?? cancelInstance.isPending}
              className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 shadow-sm backdrop-blur-sm transition-colors disabled:opacity-50"
            >
              Stop
            </button>
          )}
          {(effectiveStatus === 'failed' || effectiveStatus === 'cancelled') && (
            <button
              onClick={() => resumeInstance.mutate({ instanceId })}
              disabled={resumeInstance.isPending}
              className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-green-300 dark:border-green-700/60 hover:bg-green-50 dark:hover:bg-green-900/30 text-green-700 dark:text-green-400 shadow-sm backdrop-blur-sm transition-colors disabled:opacity-50"
            >
              {resumeInstance.isPending ? 'Resuming...' : 'Resume'}
            </button>
          )}
        </div>

        <WorkflowCanvas
          definition={definition}
          instance={{ ...instance, status: effectiveStatus, context: effectiveContext } as WorkflowInstance}
          onStageClick={handleStageClick}
          onEdgeClick={handleEdgeClick}
          onApproveGate={(stageId) => approveGate.mutate({ instanceId, stageId })}
          onRejectGate={(stageId) => rejectGate.mutate({ instanceId, stageId })}
          onJumpIn={(stageId) => handleStageClick(stageId)}
        />
      </div>

      {/* Sidebar — always visible */}
      <ResizablePanel
        side="right"
        defaultWidth={420}
        minWidth={300}
        maxWidth={700}
        className="border-l border-border min-h-0 overflow-hidden"
      >
        {selectedEdgeId ? (
          <EdgeSidebar
            edge={definition.edges.find((e) => e.id === selectedEdgeId)}
            workflow={definition}
            onClose={() => setSelectedEdgeId(null)}
          />
        ) : selectedStageId ? (
          isTriggerSelected ? (
            <TriggerSidebar
              trigger={selectedStageDef?.config as Record<string, unknown> | undefined ?? definition.trigger}
              triggerEvent={instance.trigger_event as { id: string; timestamp: string; provider?: string; payload?: unknown; metadata?: Record<string, unknown> } | undefined}
              workflowId={instance.definition_id ?? undefined}
              status={selectedStageId ? stages[selectedStageId]?.status : undefined}
              onClose={() => setSelectedStageId(null)}
            />
          ) : (selectedStageDef?.type === 'gate' || selectedStageDef?.type === 'review-gate') ? (
            <GateSidebar
              instanceId={instanceId}
              stageId={selectedStageId}
              stageDef={selectedStageDef}
              stageCtx={selectedStageCtx}
              definition={definition}
              workflowContext={effectiveContext?.stages || {}}
              onClose={() => setSelectedStageId(null)}
              onApprove={(data) => approveGate.mutate({ instanceId, stageId: selectedStageId, data })}
              onReject={() => rejectGate.mutate({ instanceId, stageId: selectedStageId })}
            />
          ) : selectedStageDef?.type === 'agent' && selectedStageCtx ? (
            selectedStageCtx.status !== 'pending' ? (
              <AgentSessionViewer
                instanceId={instanceId}
                stageId={selectedStageId}
                stageContext={selectedStageCtx}
                stageDef={selectedStageDef}
                onClose={() => setSelectedStageId(null)}
              />
            ) : (
              <PendingStageSidebar
                stageId={selectedStageId}
                stageDef={selectedStageDef}
                onClose={() => setSelectedStageId(null)}
              />
            )
          ) : (
            <GenericSidebar
              stageId={selectedStageId}
              stageDef={selectedStageDef}
              stageCtx={selectedStageCtx}
              definition={definition}
              onClose={() => setSelectedStageId(null)}
            />
          )
        ) : (
          <OverviewSidebar
            instance={instance}
            effectiveStatus={effectiveStatus}
            effectiveContext={effectiveContext}
            rawContext={rawContext}
            workflow={definition}
            isActive={isActive}
            instanceId={instanceId}
            onCancel={onCancel ?? (() => cancelInstance.mutate(instanceId))}
            onClose={onClose}
            onCleanup={onCleanup}
          />
        )}
      </ResizablePanel>
    </div>
  );
}
