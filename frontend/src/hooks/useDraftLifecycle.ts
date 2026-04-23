import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useBlocker } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  useWorkflow,
  useCreateWorkflow,
  useUpdateWorkflow,
} from './queries';
import { useUndoRedo } from './useUndoRedo';
import { authorChat, type WorkflowDefinition } from '../lib/api';

const DRAFT_ID_KEY = 'autome:draft-id';

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

export interface DraftLifecycleResult {
  // Current editable definition
  definition: WorkflowDefinition | undefined;
  // Whether there are unsaved changes (existing workflows)
  hasChanges: boolean;
  // Effective ID (real workflowId or temp draft ID)
  effectiveId: string;
  isNew: boolean;
  // Undo/redo
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  // Handlers
  handleDefinitionChange: (def: WorkflowDefinition) => void;
  handleSave: () => void;
  handleDiscardChanges: () => void;
  handleResetDraft: () => void;
  // Navigation blocker (passed through so the component can render the modal)
  blocker: ReturnType<typeof useBlocker>;
  // Mutations pending state (for button labels)
  isSavePending: boolean;
  isNew_creating: boolean;
  // Underlying workflow data (for the activate/deactivate buttons)
  workflow: WorkflowDefinition | undefined;
  isLoading: boolean;
  error: Error | null;
  // Expose setDefinition (silent update without history) for name/description inline edits on new workflows
  setDefinitionSilent: (def: WorkflowDefinition) => void;
  // Exposed for the WebSocket AI author listener in WorkflowEditor
  pushDefinition: (def: WorkflowDefinition) => void;
  setHasChanges: (v: boolean) => void;
}

export function useDraftLifecycle(workflowId: string | undefined): DraftLifecycleResult {
  const navigate = useNavigate();
  const isNew = !workflowId;
  const queryClient = useQueryClient();

  // Per-tab temp ID that survives page refresh but is unique per tab.
  const [tempId] = useState(() => {
    const existing = sessionStorage.getItem(DRAFT_ID_KEY);
    if (existing) return existing;
    const id = generateTempId();
    sessionStorage.setItem(DRAFT_ID_KEY, id);
    return id;
  });
  const effectiveId = workflowId || tempId;

  // Clear persisted temp ID when workflow is saved (isNew becomes false).
  useEffect(() => {
    if (!isNew) {
      sessionStorage.removeItem(DRAFT_ID_KEY);
    }
  }, [isNew]);

  // Load existing workflow (skipped for new)
  const { data: workflow, isLoading, error } = useWorkflow(isNew ? undefined : workflowId);

  // Mutations
  const createMutation = useCreateWorkflow();
  const updateMutation = useUpdateWorkflow();

  const [hasChanges, setHasChanges] = useState(false);
  const skipBlockerRef = useRef(false);
  const userEditedRef = useRef(false);

  // Undo/redo stack
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

  // Block navigation when there are unsaved changes
  const blocker = useBlocker({
    condition: !skipBlockerRef.current && (hasChanges || (isNew && userEditedRef.current)),
  });

  // Seed undo stack from server when existing workflow first loads; restore draft if present
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
    // Check if server has a draft that differs from the saved workflow
    fetch(`/api/internal/author-draft/${workflowId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((draft) => {
        if (draft && JSON.stringify(draft) !== JSON.stringify(workflow)) {
          resetHistory(draft);
          setHasChanges(true);
        }
      })
      .catch((err) => console.warn('[draft-restore]', err));
  }, [isNew, workflow, workflowId, tempId, initialDef, resetHistory]);

  // Use undo/redo-managed definition; fall back to fetched workflow during initial load
  const currentDefinition = isNew
    ? (editedDefinition as WorkflowDefinition)
    : (editedDefinition || workflow);

  // Track current definition in a ref so WebSocket listener can detect echoes
  const definitionRef = useRef(currentDefinition);
  definitionRef.current = currentDefinition;

  const handleDefinitionChange = useCallback(
    (def: WorkflowDefinition) => {
      // Reference inequality is sufficient: callers always produce a new object when
      // the definition actually changed (ConfigPanel, EdgeConfigPanel, etc.).
      const changed = def !== definitionRef.current;
      pushDefinition(def);
      if (changed) userEditedRef.current = true;
      if (!isNew && changed) setHasChanges(true);
      // Sync to server draft so AI Author MCP server sees the latest state
      if (changed) {
        fetch(`/api/internal/author-draft/${effectiveId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(def),
        })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ['workflow-validation', effectiveId] });
          })
          .catch((err) => console.warn('[draft-sync]', err));
      }
    },
    [effectiveId, isNew, pushDefinition, queryClient],
  );

  const setDefinitionSilent = useCallback(
    (def: WorkflowDefinition) => {
      setDefinition(def);
    },
    [setDefinition],
  );

  const handleSave = useCallback(() => {
    if (isNew) {
      skipBlockerRef.current = true;
      const { id: _id, ...data } = currentDefinition as WorkflowDefinition;
      createMutation.mutate(data, {
        onSuccess: async (created) => {
          userEditedRef.current = false;
          // Migrate draft author messages to the real workflow ID
          await authorChat.migrateSegments(tempId, created.id).catch(() => {});
          // Clear the temp draft — it now lives under the real workflow ID
          fetch(`/api/internal/author-draft/${tempId}`, { method: 'DELETE' }).catch(() => {});
          navigate({ to: '/workflows/$workflowId', params: { workflowId: created.id } });
        },
        onError: () => {
          skipBlockerRef.current = false;
        },
      });
    } else {
      if (!editedDefinition) return;
      updateMutation.mutate(
        { id: workflowId!, data: editedDefinition },
        {
          onSuccess: () => {
            queryClient.setQueryData(['workflow', workflowId], editedDefinition);
            setHasChanges(false);
            userEditedRef.current = false;
            resetHistory(editedDefinition);
            // Clear server draft — it now matches saved version
            fetch(`/api/internal/author-draft/${workflowId}`, { method: 'DELETE' }).catch(() => {});
          },
        },
      );
    }
  }, [isNew, currentDefinition, editedDefinition, workflowId, tempId, createMutation, updateMutation, queryClient, navigate, resetHistory]);

  const handleDiscardChanges = useCallback(() => {
    if (!isNew && workflow) {
      resetHistory(workflow);
      setHasChanges(false);
      fetch(`/api/internal/author-draft/${workflowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflow),
      }).catch(() => {});
    }
    if (isNew) {
      sessionStorage.removeItem(DRAFT_ID_KEY);
      authorChat.clearSegments(effectiveId).catch(() => {});
    }
    if (blocker.status === 'blocked') {
      blocker.proceed();
    }
  }, [isNew, workflow, workflowId, effectiveId, resetHistory, blocker]);

  const handleResetDraft = useCallback(() => {
    userEditedRef.current = false;
    // Clear the old draft chat segments before generating a new ID
    authorChat.clearSegments(effectiveId).catch(() => {});
    // Generate a fresh temp ID so the new blank draft doesn't collide with any
    // in-flight server state from the old session.
    const newTempId = generateTempId();
    sessionStorage.setItem(DRAFT_ID_KEY, newTempId);
    // Reset the undo/redo stack to a blank definition — no reload needed.
    resetHistory(createBlankDefinition(newTempId));
    setHasChanges(false);
    // Seed the new blank draft to the server
    fetch(`/api/internal/author-draft/${newTempId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBlankDefinition(newTempId)),
    }).catch((err) => console.warn('[draft-sync]', err));
  }, [effectiveId, resetHistory]);

  return {
    definition: currentDefinition as WorkflowDefinition | undefined,
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
    isSavePending: isNew ? createMutation.isPending : updateMutation.isPending,
    isNew_creating: createMutation.isPending,
    workflow: workflow as WorkflowDefinition | undefined,
    isLoading,
    error: error as Error | null,
    setDefinitionSilent,
    pushDefinition,
    setHasChanges,
  };
}
