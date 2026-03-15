import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { CommandPalette } from './canvas/CommandPalette';
import { ShortcutsHelp } from './canvas/ShortcutsHelp';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { useQueryClient } from '@tanstack/react-query';
import {
  useWorkflow,
  useCreateWorkflow,
  useUpdateWorkflow,
  useTriggerWorkflow,
  useDeleteWorkflow,
  useInstance,
  useInstanceStatus,
  useWorkflowVersions,
  useNodeTypes,
} from '../hooks/queries';
import { useWebSocket } from '../hooks/useWebSocket';
import { WorkflowCanvas, findBackEdgeIds, type WorkflowCanvasHandle } from './canvas/WorkflowCanvas';
import { ConfigPanel, EdgeConfigPanel } from './canvas/ConfigPanel';
import { AuthorChat } from './author/AuthorChat';
import { TriggerDialog } from './TriggerDialog';
import { ResizablePanel } from './ui/ResizablePanel';
import { IconSidebar, type SidebarTab } from './canvas/IconSidebar';
import { NodePalette } from './canvas/NodePalette';
import { RuntimeViewer } from './instance/RuntimeViewer';
import { StatusBadge } from './ui/StatusBadge';
import { WorkflowInfoBubble } from './canvas/WorkflowInfoBubble';
import { WorkflowHealthIndicator } from './WorkflowHealthIndicator';
import { WorkflowSettings } from './canvas/WorkflowSettings';
import {
  authorChat,
  workflows as workflowsApi,
  type WorkflowDefinition,
  type StageDefinition,
  type EdgeDefinition,
} from '../lib/api';

export interface WorkflowEditorProps {
  /** If provided, load existing workflow from DB. If omitted, create a blank draft. */
  workflowId?: string;
}

function generateTempId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBlankDefinition(tempId: string): WorkflowDefinition {
  return {
    id: tempId,
    name: 'Untitled Workflow',
    description: '',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
  };
}

export function WorkflowEditor({ workflowId }: WorkflowEditorProps) {
  const navigate = useNavigate();
  const isNew = !workflowId;

  // For new workflows, generate a stable temp ID
  const [tempId] = useState(generateTempId);
  const effectiveId = workflowId || tempId;

  // Load existing workflow (skipped for new — disabled when id is undefined)
  const { data: workflow, isLoading, error } = useWorkflow(isNew ? undefined : workflowId);

  // Node type info (used to determine triggerMode without hardcoded type ID checks)
  const { data: nodeTypeList } = useNodeTypes();

  // Mutations
  const createMutation = useCreateWorkflow();
  const updateMutation = useUpdateWorkflow();
  const triggerMutation = useTriggerWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const queryClient = useQueryClient();

  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('author');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false);
  const [testRunTriggerOpen, setTestRunTriggerOpen] = useState(false);
  const [testRunInstanceId, setTestRunInstanceId] = useState<string | null>(null);
  const [testRunWorkflowId, setTestRunWorkflowId] = useState<string | null>(null);
  const [testRunStarting, setTestRunStarting] = useState(false);

  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  // Subscribe to workflow-scoped events plus the active test run instance
  const wsSubscriptions = testRunInstanceId
    ? [`workflow:${effectiveId}`, `instance:${testRunInstanceId}`]
    : [`workflow:${effectiveId}`];
  const { on } = useWebSocket(wsSubscriptions);

  // Test run data fetching
  const { data: testRunInstance } = useInstance(testRunInstanceId || '');
  const { data: testRunLiveStatus } = useInstanceStatus(testRunInstanceId || '');

  // Version history (existing workflows only)
  const { data: versionHistory } = useWorkflowVersions(isNew ? undefined : workflowId);

  // Undo/redo for definition edits
  // New: initialized with blank definition
  // Existing: initialized with null, reset to fetched workflow once it loads
  const [initialDef] = useState(() => createBlankDefinition(tempId));
  const {
    current: editedDefinition,
    pushState: pushDefinition,
    set: setDefinition,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetHistory,
  } = useUndoRedo<WorkflowDefinition | null>(isNew ? initialDef : null);

  // When the existing workflow first loads, seed the undo stack with it
  const initialSyncDone = useRef(false);
  useEffect(() => {
    if (isNew) {
      // Seed initial draft to server on mount (new workflow only)
      fetch(`/api/internal/author-draft/${tempId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initialDef),
      }).catch((err) => console.warn('[draft-sync]', err));
      return;
    }
    if (!workflow || initialSyncDone.current) return;
    initialSyncDone.current = true;
    resetHistory(workflow);
    // Seed draft to server so MCP author has current data
    fetch(`/api/internal/author-draft/${workflowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    }).catch((err) => console.warn('[draft-sync]', err));
  }, [isNew, workflow, workflowId, tempId, initialDef, resetHistory]);

  // Use the undo/redo-managed definition; fall back to fetched workflow during initial load
  const currentDefinition = isNew ? (editedDefinition as WorkflowDefinition) : (editedDefinition || workflow);

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
  }, [on, effectiveId, isNew, pushDefinition]);

  const handleDefinitionChange = useCallback(
    (def: WorkflowDefinition) => {
      pushDefinition(def);
      if (!isNew) setHasChanges(true);
      // Sync to server draft so the AI Author MCP server sees the latest state
      fetch(`/api/internal/author-draft/${effectiveId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(def),
      }).catch((err) => console.warn('[draft-sync]', err));
    },
    [effectiveId, isNew, pushDefinition],
  );

  const handleSave = useCallback(() => {
    if (isNew) {
      // Strip the temp id and create in DB
      const { id: _id, ...data } = currentDefinition as WorkflowDefinition;
      createMutation.mutate(data, {
        onSuccess: async (created) => {
          // Migrate draft author messages to the real workflow ID
          await authorChat.migrateSegments(tempId, created.id).catch(() => {});
          navigate({ to: '/workflows/$workflowId', params: { workflowId: created.id } });
        },
      });
    } else {
      if (!editedDefinition) return;
      updateMutation.mutate(
        { id: workflowId!, data: editedDefinition },
        {
          onSuccess: () => {
            // Set query cache directly so there's no flash of stale data
            queryClient.setQueryData(['workflow', workflowId], editedDefinition);
            setHasChanges(false);
            resetHistory(editedDefinition);
          },
        },
      );
    }
  }, [isNew, currentDefinition, editedDefinition, workflowId, tempId, createMutation, updateMutation, queryClient, navigate, resetHistory]);

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
      const newDef: WorkflowDefinition = {
        ...currentDefinition,
        stages: currentDefinition.stages.map((s) => (s.id === updated.id ? updated : s)),
      };
      handleDefinitionChange(newDef);
    },
    [currentDefinition, handleDefinitionChange],
  );

  const handleStageDelete = useCallback(() => {
    if (!currentDefinition || !selectedStageId) return;
    const newDef: WorkflowDefinition = {
      ...currentDefinition,
      stages: currentDefinition.stages.filter((s) => s.id !== selectedStageId),
      edges: currentDefinition.edges.filter((e) => e.source !== selectedStageId && e.target !== selectedStageId),
    };
    setSelectedStageId(null);
    handleDefinitionChange(newDef);
  }, [currentDefinition, selectedStageId, handleDefinitionChange]);

  const handleEdgeSave = useCallback(
    (updated: EdgeDefinition) => {
      if (!currentDefinition) return;
      const newDef: WorkflowDefinition = {
        ...currentDefinition,
        edges: currentDefinition.edges.map((e) => (e.id === updated.id ? updated : e)),
      };
      handleDefinitionChange(newDef);
    },
    [currentDefinition, handleDefinitionChange],
  );

  const handleEdgeDelete = useCallback(() => {
    if (!currentDefinition || !selectedEdgeId) return;
    const newDef: WorkflowDefinition = {
      ...currentDefinition,
      edges: currentDefinition.edges.filter((e) => e.id !== selectedEdgeId),
    };
    setSelectedEdgeId(null);
    handleDefinitionChange(newDef);
  }, [currentDefinition, selectedEdgeId, handleDefinitionChange]);

  // Called when AI author turn completes — drafts already flow via WebSocket
  const handleWorkflowUpdated = useCallback(() => {
    // No-op — draft changes arrive via author:draft WebSocket events
  }, []);

  // Called when user clicks a node in the NodePalette
  const handleAddNodeFromPalette = useCallback(
    (type: string) => {
      if (!currentDefinition) return;
      const existingIds = currentDefinition.stages.map((s) => s.id);
      const base = type;
      let counter = 1;
      while (existingIds.includes(`${base}-${counter}`)) counter++;
      const id = `${base}-${counter}`;
      const lowestY =
        currentDefinition.stages.length > 0
          ? Math.max(...currentDefinition.stages.map((s) => (s.position?.y ?? 0))) + 150
          : 100;
      const position = { x: 200, y: lowestY };
      const label = type
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      handleDefinitionChange({
        ...currentDefinition,
        stages: [...currentDefinition.stages, { id, type, position, label, config: {} }],
      });
    },
    [currentDefinition, handleDefinitionChange],
  );

  const handleTestRunTrigger = useCallback(
    async (payload: Record<string, unknown>) => {
      setTestRunStarting(true);
      try {
        const result = await workflowsApi.testRun(effectiveId, payload);
        setTestRunInstanceId(result.instance.id);
        setTestRunWorkflowId(result.testWorkflowId);
        setTestRunTriggerOpen(false);
      } catch (err) {
        toast.error(`Failed to start test run: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setTestRunStarting(false);
      }
    },
    [effectiveId],
  );

  const handleTestRunClose = useCallback(() => {
    // Delete the test workflow — cascades to its instances
    if (testRunWorkflowId) {
      deleteWorkflow.mutate(testRunWorkflowId);
    }
    setTestRunInstanceId(null);
    setTestRunWorkflowId(null);
  }, [testRunWorkflowId, deleteWorkflow]);

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
              resetHistory(updated);
              setHasChanges(false);
              // version history is now in the sidebar, no dropdown to close
            },
          },
        );
      } catch (err) {
        toast.error(`Failed to restore version: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRestoringVersion(null);
      }
    },
    [isNew, workflowId, updateMutation, queryClient, resetHistory],
  );

  // Ref to imperative canvas actions (fitView, selectAll, relayout) exposed by WorkflowCanvas
  const canvasActionsRef = useRef<WorkflowCanvasHandle | null>(null);

  const backEdgeIds = useMemo(
    () => (currentDefinition ? findBackEdgeIds(currentDefinition) : new Set<string>()),
    [currentDefinition],
  );

  const handleNameChange = useCallback(
    (name: string) => {
      if (!currentDefinition) return;
      if (isNew) {
        setDefinition({ ...currentDefinition, name });
      } else {
        handleDefinitionChange({ ...currentDefinition, name });
      }
    },
    [isNew, currentDefinition, handleDefinitionChange, setDefinition],
  );

  const handleDescriptionChange = useCallback(
    (description: string) => {
      if (!currentDefinition) return;
      if (isNew) {
        setDefinition({ ...currentDefinition, description });
      } else {
        handleDefinitionChange({ ...currentDefinition, description });
      }
    },
    [isNew, currentDefinition, handleDefinitionChange, setDefinition],
  );

  const handleRunClick = useCallback(() => {
    const triggerStage = currentDefinition?.stages.find((s) => s.type.endsWith('-trigger'));
    const triggerNodeInfo = nodeTypeList?.find((nt) => nt.id === triggerStage?.type);
    const triggerMode = triggerNodeInfo?.triggerMode ?? 'prompt';
    if (triggerMode === 'immediate') {
      triggerMutation.mutate({
        id: workflowId!,
        payload: { source: 'cron', scheduled_at: new Date().toISOString() },
      });
    } else {
      setTriggerDialogOpen(true);
    }
  }, [currentDefinition, nodeTypeList, workflowId, triggerMutation]);

  const handleTestRunClick = useCallback(() => {
    const triggerStage = currentDefinition?.stages.find((s) => s.type.endsWith('-trigger'));
    const triggerNodeInfo = nodeTypeList?.find((nt) => nt.id === triggerStage?.type);
    const triggerMode = triggerNodeInfo?.triggerMode ?? 'prompt';
    if (triggerMode === 'immediate') {
      handleTestRunTrigger({ source: 'cron', scheduled_at: new Date().toISOString() });
    } else {
      setTestRunTriggerOpen(true);
    }
  }, [currentDefinition, nodeTypeList, handleTestRunTrigger]);

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

  // Loading / error states (existing workflows only)
  if (!isNew && isLoading) return <div className="p-6 text-text-secondary">Loading...</div>;
  if (!isNew && error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {(error as Error).message}</div>;
  if (!isNew && !currentDefinition) return <div className="p-6 text-text-secondary">Workflow not found</div>;

  // currentDefinition is always defined at this point
  const definition = currentDefinition as WorkflowDefinition;

  const selectedStage = selectedStageId ? definition.stages.find((s) => s.id === selectedStageId) : null;
  const selectedEdge = selectedEdgeId ? definition.edges.find((e) => e.id === selectedEdgeId) : null;
  const isSelectedEdgeCycle = selectedEdgeId ? backEdgeIds.has(selectedEdgeId) : false;

  // Test run mode: show RuntimeViewer instead of the author canvas
  if (testRunInstanceId && testRunInstance) {
    const effectiveStatus = testRunLiveStatus?.status ?? testRunInstance.status;

    return (
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Test run header */}
        <div className="px-6 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={handleTestRunClose} className="text-text-tertiary hover:text-text-secondary text-sm">
              {'\u2190'} Back to Editor
            </button>
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold">{definition.name}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 font-medium">
                Test Run
              </span>
              <StatusBadge status={effectiveStatus} size="md" />
            </div>
          </div>
          <button
            onClick={handleTestRunClose}
            className="px-3 py-1.5 text-sm border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg transition-colors"
          >
            Stop &amp; Close
          </button>
        </div>

        <RuntimeViewer
          instanceId={testRunInstanceId}
          definition={definition}
          instance={testRunInstance}
          liveStatus={testRunLiveStatus}
        />
      </div>
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
          <ResizablePanel
            side="left"
            defaultWidth={384}
            minWidth={280}
            maxWidth={600}
            className="border-r border-border flex flex-col bg-surface min-h-0 overflow-hidden"
          >
            <div className="flex flex-col h-full">
              {/* Panel content */}
              <div className="flex-1 overflow-hidden min-h-0">
                {sidebarTab === 'author' && (
                  <AuthorChat
                    workflowId={effectiveId}
                    currentDefinition={definition}
                    onWorkflowUpdated={handleWorkflowUpdated}
                  />
                )}
                {sidebarTab === 'nodes' && <NodePalette onAddNode={handleAddNodeFromPalette} />}
                {sidebarTab === 'settings' && (
                  <WorkflowSettings
                    isNew={isNew}
                    currentVersion={definition.version}
                    versionHistory={versionHistory as { version: number; created_at: string }[] | undefined}
                    restoringVersion={restoringVersion}
                    onRestoreVersion={handleRestoreVersion}
                    onExport={!isNew ? handleExport : undefined}
                    healthIndicator={!isNew ? <WorkflowHealthIndicator workflowId={workflowId!} /> : undefined}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
        )}

        {/* Workflow canvas */}
        <div className="flex-1 overflow-hidden min-h-0 relative">
          {/* Floating widget 1: workflow info — top-left of canvas */}
          <WorkflowInfoBubble
            name={definition.name}
            description={definition.description || ''}
            onNameChange={handleNameChange}
            onDescriptionChange={handleDescriptionChange}
            backLink={isNew ? undefined : '/'}
            onBack={isNew ? () => navigate({ to: '/' }) : undefined}
          />

          {/* Floating widget 2: actions — top-right of canvas */}
          <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5">
            <button
              onClick={handleTestRunClick}
              className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] shadow-sm backdrop-blur-sm transition-colors"
            >
              Test Run
            </button>

            {!isNew && (
              <button
                onClick={handleRunClick}
                disabled={triggerMutation.isPending}
                className="px-2.5 py-1.5 text-xs rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] shadow-sm backdrop-blur-sm transition-colors disabled:opacity-50"
              >
                {triggerMutation.isPending ? 'Running...' : 'Run'}
              </button>
            )}
          </div>

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
            saveDisabled={isNew ? createMutation.isPending : (updateMutation.isPending || !hasChanges)}
            saveLabel={isNew ? (createMutation.isPending ? 'Creating...' : 'Save') : (updateMutation.isPending ? 'Saving...' : 'Save')}
            onCanvasReady={(actions) => { canvasActionsRef.current = actions; }}
          />
        </div>

        {/* Config panel — show stage or edge config depending on selection */}
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

      {/* Run trigger dialog — existing workflows only */}
      {!isNew && (
        <TriggerDialog
          workflowName={definition.name}
          isOpen={triggerDialogOpen}
          onClose={() => setTriggerDialogOpen(false)}
          onTrigger={(payload) => {
            triggerMutation.mutate(
              { id: workflowId!, payload },
              { onSuccess: () => setTriggerDialogOpen(false) },
            );
          }}
          isPending={triggerMutation.isPending}
        />
      )}

      <TriggerDialog
        workflowName={`${definition.name} (Test Run)`}
        isOpen={testRunTriggerOpen}
        onClose={() => setTestRunTriggerOpen(false)}
        onTrigger={handleTestRunTrigger}
        isPending={testRunStarting}
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
    </div>
  );
}
