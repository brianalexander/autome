import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { CommandPalette } from './canvas/CommandPalette';
import { ShortcutsHelp } from './canvas/ShortcutsHelp';
import { useQueryClient } from '@tanstack/react-query';
import {
  useUpdateWorkflow,
  useWorkflowVersions,
  useNodeTypes,
  useInstance,
  useInstanceStatus,
} from '../hooks/queries';
import { useWebSocket } from '../hooks/useWebSocket';
import { WorkflowCanvas, findBackEdgeIds, generateStageId, createDefaultStage, type WorkflowCanvasHandle } from './canvas/WorkflowCanvas';
import { ConfigPanel, EdgeConfigPanel } from './canvas/ConfigPanel';
import { AuthorChat } from './author/AuthorChat';
import { TriggerDialog } from './TriggerDialog';
import { ResizablePanel } from './ui/ResizablePanel';
import { IconSidebar, type SidebarTab } from './canvas/IconSidebar';
import { NodePalette } from './canvas/NodePalette';
import { RuntimeViewer } from './instance/RuntimeViewer';
import { WorkflowInfoBubble } from './canvas/WorkflowInfoBubble';
import { WorkflowHealthIndicator } from './WorkflowHealthIndicator';
import { WorkflowSettings } from './canvas/WorkflowSettings';
import {
  workflows as workflowsApi,
  isTriggerType,
  type WorkflowDefinition,
  type StageDefinition,
  type EdgeDefinition,
} from '../lib/api';
import { useDraftLifecycle } from '../hooks/useDraftLifecycle';
import { useTestRun } from '../hooks/useTestRun';

// ---------------------------------------------------------------------------
// Small co-located sub-components (not exported — only used by WorkflowEditor)
// ---------------------------------------------------------------------------

interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ title, body, confirmLabel, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-xl w-full max-w-sm p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-text-primary mb-2">{title}</h3>
        <p className="text-xs text-text-secondary mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-secondary transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CanvasActionsProps {
  isNew: boolean;
  hasChanges: boolean;
  onReset: () => void;
  onDiscard: () => void;
  onTestRun: () => void;
}

function CanvasActions({
  isNew, hasChanges,
  onReset, onDiscard, onTestRun,
}: CanvasActionsProps) {
  const btnBase = 'px-2.5 py-1.5 text-xs rounded-lg border shadow-sm backdrop-blur-sm transition-colors';
  const btnDefault = `${btnBase} bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]`;
  return (
    <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
      {isNew && (
        <button onClick={onReset} className={`${btnBase} bg-[var(--color-surface)] border-[var(--color-border)] text-red-500 hover:text-red-400`}>
          Reset
        </button>
      )}
      {!isNew && hasChanges && (
        <button onClick={onDiscard} className={`${btnBase} bg-[var(--color-surface)] border-[var(--color-border)] text-red-500 hover:text-red-400`}>
          Discard
        </button>
      )}
      <button onClick={onTestRun} className={btnDefault}>Test Run</button>
    </div>
  );
}

interface TestRunViewProps {
  instanceId: string;
  definition: WorkflowDefinition;
  instance: ReturnType<typeof useInstance>['data'];
  liveStatus: ReturnType<typeof useInstanceStatus>['data'];
  onClose: () => void;
}

function TestRunView({ instanceId, definition, instance, liveStatus, onClose }: TestRunViewProps) {
  const effectiveStatus = liveStatus?.status ?? instance!.status;
  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <RuntimeViewer
        instanceId={instanceId}
        definition={definition}
        instance={instance!}
        liveStatus={liveStatus}
        onClose={onClose}
        workflowName={`${definition.name} — Test Run`}
        effectiveStatus={effectiveStatus}
      />
    </div>
  );
}

interface SidebarPanelProps {
  tab: SidebarTab;
  effectiveId: string;
  definition: WorkflowDefinition;
  isNew: boolean;
  versionHistory: { version: number; created_at: string }[] | undefined;
  restoringVersion: number | null;
  onWorkflowUpdated: () => void;
  onAddNode: (type: string) => void;
  onRestoreVersion: (version: number) => void;
  onExport: (() => void) | undefined;
  healthIndicator: ReactNode | undefined;
}

function SidebarPanel({
  tab, effectiveId, definition, isNew, versionHistory, restoringVersion,
  onWorkflowUpdated, onAddNode, onRestoreVersion, onExport, healthIndicator,
}: SidebarPanelProps) {
  return (
    <ResizablePanel side="left" defaultWidth={384} minWidth={280} maxWidth={600} className="border-r border-border flex flex-col bg-surface min-h-0 overflow-hidden">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-hidden min-h-0">
          {tab === 'author' && <AuthorChat workflowId={effectiveId} currentDefinition={definition} onWorkflowUpdated={onWorkflowUpdated} />}
          {tab === 'nodes' && <NodePalette onAddNode={onAddNode} />}
          {tab === 'settings' && (
            <WorkflowSettings
              isNew={isNew}
              currentVersion={definition.version}
              versionHistory={versionHistory}
              restoringVersion={restoringVersion}
              onRestoreVersion={onRestoreVersion}
              onExport={onExport}
              healthIndicator={healthIndicator}
            />
          )}
        </div>
      </div>
    </ResizablePanel>
  );
}

// ---------------------------------------------------------------------------

export interface WorkflowEditorProps {
  /** If provided, load existing workflow from DB. If omitted, create a blank draft. */
  workflowId?: string;
}

export function WorkflowEditor({ workflowId }: WorkflowEditorProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // --- Draft lifecycle (loading, saving, undo/redo, navigation blocker) ---
  const {
    definition: currentDefinition,
    hasChanges,
    effectiveId,
    isNew,
    undo,
    redo,
    canUndo,
    canRedo,
    handleDefinitionChange,
    handleSave,
    handleDiscardChanges,
    handleResetDraft,
    blocker,
    isSavePending,
    isNew_creating,
    isLoading,
    error,
    setDefinitionSilent,
    pushDefinition,
    setHasChanges,
  } = useDraftLifecycle(workflowId);

  // --- UI state ---
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('author');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);

  // --- Mutations ---
  const updateMutation = useUpdateWorkflow();

  // --- Node types (for trigger mode detection) ---
  const { data: nodeTypeList } = useNodeTypes();

  // --- Version history ---
  const { data: versionHistory } = useWorkflowVersions(isNew ? undefined : workflowId);

  // --- Test run ---
  const testRun = useTestRun({ definition: currentDefinition, effectiveId });
  const {
    isTestActive,
    testInstance,
    testStatus: testRunLiveStatus,
    testRunValidation,
    testRunTriggerOpen,
    testRunStarting,
    handleTestRunClick,
    handleTriggerSubmit,
    handleTriggerDialogClose,
    handleTestRunClose,
    testRunInstanceId,
  } = testRun;

  // --- WebSocket subscriptions ---
  const wsSubscriptions = testRunInstanceId
    ? [`workflow:${effectiveId}`, `instance:${testRunInstanceId}`]
    : [`workflow:${effectiveId}`];
  const { on } = useWebSocket(wsSubscriptions);

  // Track current definition so the WS listener can detect echoes
  const definitionRef = useRef(currentDefinition);
  definitionRef.current = currentDefinition;

  // Listen for AI Author draft updates — only push if the definition actually changed
  useEffect(() => {
    const unsub = on('author:draft', (data: unknown) => {
      const d = data as { workflowId?: string; definition?: unknown };
      if (d.workflowId !== effectiveId) return;
      if (JSON.stringify(d.definition) === JSON.stringify(definitionRef.current)) return;
      pushDefinition(d.definition as WorkflowDefinition);
      if (!isNew) setHasChanges(true);
    });
    return unsub;
  }, [on, effectiveId, isNew, pushDefinition, setHasChanges]);

  // --- Canvas ref ---
  const canvasActionsRef = useRef<WorkflowCanvasHandle | null>(null);

  // --- Selection handlers ---
  const handleStageSelect = useCallback((stageId: string | null) => {
    setSelectedStageId(stageId);
    setSelectedEdgeId(null);
  }, []);

  const handleEdgeSelect = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    setSelectedStageId(null);
  }, []);

  const handleStageSave = useCallback(
    (updated: StageDefinition) => {
      if (!currentDefinition) return;
      handleDefinitionChange({
        ...currentDefinition,
        stages: currentDefinition.stages.map((s) => (s.id === updated.id ? updated : s)),
      });
    },
    [currentDefinition, handleDefinitionChange],
  );

  const handleStageDelete = useCallback(() => {
    if (!currentDefinition || !selectedStageId) return;
    const newDef: WorkflowDefinition = {
      ...currentDefinition,
      stages: currentDefinition.stages.filter((s) => s.id !== selectedStageId),
      edges: currentDefinition.edges.filter(
        (e) => e.source !== selectedStageId && e.target !== selectedStageId,
      ),
    };
    setSelectedStageId(null);
    handleDefinitionChange(newDef);
  }, [currentDefinition, selectedStageId, handleDefinitionChange]);

  const handleEdgeSave = useCallback(
    (updated: EdgeDefinition) => {
      if (!currentDefinition) return;
      handleDefinitionChange({
        ...currentDefinition,
        edges: currentDefinition.edges.map((e) => (e.id === updated.id ? updated : e)),
      });
    },
    [currentDefinition, handleDefinitionChange],
  );

  const handleEdgeDelete = useCallback(() => {
    if (!currentDefinition || !selectedEdgeId) return;
    handleDefinitionChange({
      ...currentDefinition,
      edges: currentDefinition.edges.filter((e) => e.id !== selectedEdgeId),
    });
    setSelectedEdgeId(null);
  }, [currentDefinition, selectedEdgeId, handleDefinitionChange]);

  // Called when AI author turn completes — drafts already flow via WebSocket
  const handleWorkflowUpdated = useCallback(() => {
    // No-op — draft changes arrive via author:draft WebSocket events
  }, []);

  // Add a node from the palette — uses the same ID generation and default-stage
  // creation as WorkflowCanvas.onAddStage so the two code paths stay in sync.
  const handleAddNodeFromPalette = useCallback(
    (type: string) => {
      if (!currentDefinition) return;
      const existingIds = currentDefinition.stages.map((s) => s.id);
      const spec = nodeTypeList?.find((s) => s.id === type);
      const label = spec?.name || type.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const id = generateStageId(type, existingIds, label);
      const lowestY =
        currentDefinition.stages.length > 0
          ? Math.max(...currentDefinition.stages.map((s) => (s.position?.y ?? 0))) + 150
          : 100;
      const position = { x: 200, y: lowestY };
      const newStage = createDefaultStage(type, id, position, nodeTypeList ?? undefined);
      handleDefinitionChange({
        ...currentDefinition,
        stages: [...currentDefinition.stages, newStage],
      });
    },
    [currentDefinition, handleDefinitionChange, nodeTypeList],
  );

  // Restore a previous version
  const handleRestoreVersion = useCallback(
    async (version: number) => {
      if (isNew || !workflowId) return;
      try {
        setRestoringVersion(version);
        const oldDef = await workflowsApi.getVersion(workflowId, version);
        const { id: _id, version: _v, ...restorable } = oldDef;
        updateMutation.mutate(
          { id: workflowId, data: restorable },
          {
            onSuccess: (updated) => {
              queryClient.setQueryData(['workflow', workflowId], updated);
              queryClient.invalidateQueries({ queryKey: ['workflow-versions', workflowId] });
              handleDefinitionChange(updated);
              setRestoringVersion(null);
            },
          },
        );
      } catch (err) {
        toast.error(`Failed to restore version: ${err instanceof Error ? err.message : String(err)}`);
        setRestoringVersion(null);
      }
    },
    [isNew, workflowId, updateMutation, queryClient, handleDefinitionChange],
  );

  // Name / description inline edits
  const handleNameChange = useCallback(
    (name: string) => {
      if (!currentDefinition) return;
      if (isNew) {
        setDefinitionSilent({ ...currentDefinition, name });
      } else {
        handleDefinitionChange({ ...currentDefinition, name });
      }
    },
    [isNew, currentDefinition, handleDefinitionChange, setDefinitionSilent],
  );

  const handleDescriptionChange = useCallback(
    (description: string) => {
      if (!currentDefinition) return;
      if (isNew) {
        setDefinitionSilent({ ...currentDefinition, description });
      } else {
        handleDefinitionChange({ ...currentDefinition, description });
      }
    },
    [isNew, currentDefinition, handleDefinitionChange, setDefinitionSilent],
  );

  // Export bundle
  const handleExport = useCallback(async () => {
    try {
      const blob = await workflowsApi.exportBundle(workflowId!);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentDefinition?.name || 'workflow'}.autome`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [workflowId, currentDefinition?.name]);

  // Trigger schema for TriggerDialog
  const triggerSchema = useMemo(() => {
    const triggerStage = currentDefinition?.stages.find((s) => isTriggerType(s.type));
    return (triggerStage?.config as Record<string, unknown>)?.output_schema as
      | Record<string, unknown>
      | undefined;
  }, [currentDefinition]);

  // Back-edge detection for cycle highlighting
  const backEdgeIds = useMemo(
    () => (currentDefinition ? findBackEdgeIds(currentDefinition) : new Set<string>()),
    [currentDefinition],
  );

  // Global keyboard shortcuts
  useKeyboardShortcuts({
    onUndo: undo,
    onRedo: redo,
    onSave: handleSave,
    onDelete: () => {
      if (selectedStageId) handleStageDelete();
      else if (selectedEdgeId) handleEdgeDelete();
    },
    onEscape: () => {
      if (commandPaletteOpen) { setCommandPaletteOpen(false); return; }
      if (shortcutsHelpOpen) { setShortcutsHelpOpen(false); return; }
      setSelectedStageId(null);
      setSelectedEdgeId(null);
      canvasActionsRef.current?.deselectAll();
    },
    onCommandPalette: () => setCommandPaletteOpen(true),
    onToggleAuthor: () => setSidebarTab((t) => (t === 'author' ? null : 'author')),
    onToggleNodes: () => setSidebarTab((t) => (t === 'nodes' ? null : 'nodes')),
    onToggleSettings: () => setSidebarTab((t) => (t === 'settings' ? null : 'settings')),
    onShortcutsHelp: () => setShortcutsHelpOpen(true),
    onSelectAll: () => canvasActionsRef.current?.selectAll(),
    onFitView: () => canvasActionsRef.current?.fitView(),
    onRelayout: () => canvasActionsRef.current?.relayout(),
  });

  // --- Loading / error states ---
  if (!isNew && isLoading) return <div className="p-6 text-text-secondary">Loading...</div>;
  if (!isNew && error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {error.message}</div>;
  if (!isNew && !currentDefinition) return <div className="p-6 text-text-secondary">Workflow not found</div>;

  const definition = currentDefinition as WorkflowDefinition;

  const selectedStage = selectedStageId ? definition.stages.find((s) => s.id === selectedStageId) : null;
  const selectedEdge = selectedEdgeId ? definition.edges.find((e) => e.id === selectedEdgeId) : null;
  const isSelectedEdgeCycle = selectedEdgeId ? backEdgeIds.has(selectedEdgeId) : false;

  // Test run mode: show RuntimeViewer instead of the author canvas
  if (isTestActive && testInstance) {
    return (
      <TestRunView
        instanceId={testRunInstanceId!}
        definition={definition}
        instance={testInstance}
        liveStatus={testRunLiveStatus}
        onClose={handleTestRunClose}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Canvas + side panels */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Icon rail */}
        <IconSidebar activeTab={sidebarTab} onTabChange={setSidebarTab} />

        {/* Expandable left panel */}
        {sidebarTab && (
          <SidebarPanel
            tab={sidebarTab}
            effectiveId={effectiveId}
            definition={definition}
            isNew={isNew}
            versionHistory={versionHistory as { version: number; created_at: string }[] | undefined}
            restoringVersion={restoringVersion}
            onWorkflowUpdated={handleWorkflowUpdated}
            onAddNode={handleAddNodeFromPalette}
            onRestoreVersion={handleRestoreVersion}
            onExport={!isNew ? handleExport : undefined}
            healthIndicator={!isNew ? <WorkflowHealthIndicator workflowId={workflowId!} /> : undefined}
          />
        )}

        {/* Workflow canvas */}
        <div className="flex-1 overflow-hidden min-h-0 relative">
          {/* Floating widget 1: workflow info — top-left of canvas */}
          <WorkflowInfoBubble
            name={definition.name}
            description={definition.description || ''}
            onNameChange={handleNameChange}
            onDescriptionChange={handleDescriptionChange}
            onBack={() => navigate({ to: '/' })}
          />

          {/* Floating widget 2: actions — top-right of canvas */}
          <CanvasActions
            isNew={isNew}
            hasChanges={hasChanges}
            onReset={() => setResetModalOpen(true)}
            onDiscard={handleDiscardChanges}
            onTestRun={handleTestRunClick}
          />

          <WorkflowCanvas
            definition={definition}
            mode="author"
            onDefinitionChange={handleDefinitionChange}
            onStageClick={handleStageSelect}
            onEdgeClick={handleEdgeSelect}
            onUndo={undo}
            onRedo={redo}
            onSave={handleSave}
            onShortcutsHelp={() => setShortcutsHelpOpen(true)}
            canUndo={canUndo}
            canRedo={canRedo}
            saveDisabled={isNew ? isNew_creating : (isSavePending || !hasChanges)}
            saveLabel={isNew ? (isNew_creating ? 'Creating...' : 'Save') : (isSavePending ? 'Saving...' : 'Save')}
            onCanvasReady={(actions) => { canvasActionsRef.current = actions; }}
          />
        </div>

        {/* Config panel — stage or edge config depending on selection */}
        {selectedStage && (
          <ResizablePanel
            side="right"
            defaultWidth={384}
            minWidth={280}
            maxWidth={600}
            className="border-l border-border min-h-0 overflow-hidden"
          >
            <ConfigPanel
              stage={selectedStage}
              definition={definition}
              onSave={handleStageSave}
              onDelete={handleStageDelete}
              onClose={() => setSelectedStageId(null)}
              onDefinitionChange={handleDefinitionChange}
            />
          </ResizablePanel>
        )}
        {selectedEdge && (
          <ResizablePanel
            side="right"
            defaultWidth={384}
            minWidth={280}
            maxWidth={600}
            className="border-l border-border min-h-0 overflow-hidden"
          >
            <EdgeConfigPanel
              edge={selectedEdge}
              definition={definition}
              isCycleEdge={isSelectedEdgeCycle}
              onSave={handleEdgeSave}
              onDelete={handleEdgeDelete}
              onClose={() => setSelectedEdgeId(null)}
            />
          </ResizablePanel>
        )}
      </div>

      <TriggerDialog
        workflowName={`${definition.name} (Test Run)`}
        isOpen={testRunTriggerOpen}
        onClose={handleTriggerDialogClose}
        onTrigger={handleTriggerSubmit}
        isPending={testRunStarting}
        outputSchema={triggerSchema}
        validation={testRunValidation}
      />

      {/* Command palette and shortcuts help — fixed-position overlays */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onAddNode={handleAddNodeFromPalette}
      />
      <ShortcutsHelp
        isOpen={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
      />

      {resetModalOpen && (
        <ConfirmModal
          title="Reset Draft?"
          body="This will discard all unsaved changes and chat history for this draft. This cannot be undone."
          confirmLabel="Reset"
          onConfirm={handleResetDraft}
          onCancel={() => setResetModalOpen(false)}
        />
      )}

      {/* Navigation blocker modal */}
      {blocker.status === 'blocked' && (
        <ConfirmModal
          title={isNew ? 'Discard Draft?' : 'Discard Changes?'}
          body={isNew
            ? 'This will discard the current draft and all chat history. This cannot be undone.'
            : 'This will revert the workflow to the last saved version. Unsaved edits will be lost.'}
          confirmLabel={isNew ? 'Discard' : 'Revert'}
          onConfirm={handleDiscardChanges}
          onCancel={() => blocker.reset()}
        />
      )}
    </div>
  );
}
