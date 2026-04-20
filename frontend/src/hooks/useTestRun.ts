import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useDeleteWorkflow, useInstance, useInstanceStatus, useNodeTypes } from './queries';
import { workflows as workflowsApi, nodeTypes as nodeTypesApi, isTriggerType, type WorkflowDefinition } from '../lib/api';

const TEST_RUN_HASH = '#test-run';

export interface TestRunValidation {
  valid: boolean;
  summary: string;
  errors: string[];
  warnings: string[];
}

export interface UseTestRunOptions {
  /** The current workflow definition (used to determine trigger mode). */
  definition: WorkflowDefinition | undefined;
  /** The effective workflow ID (real or temp draft ID). */
  effectiveId: string;
}

export interface UseTestRunResult {
  /** Whether a test run is active (has instance ID + instance data loaded). */
  isTestActive: boolean;
  /** The test run instance data. */
  testInstance: ReturnType<typeof useInstance>['data'];
  /** Live status for the test run. */
  testStatus: ReturnType<typeof useInstanceStatus>['data'];
  /** Validation results fetched before opening the trigger dialog. */
  testRunValidation: TestRunValidation | null;
  /** Whether the trigger dialog is open. */
  testRunTriggerOpen: boolean;
  /** Whether the test run is starting (mutation in flight). */
  testRunStarting: boolean;
  /** Open the test run dialog (or immediately trigger if mode is 'immediate'). */
  handleTestRunClick: () => Promise<void>;
  /** Called when user submits the trigger form. */
  handleTriggerSubmit: (payload: Record<string, unknown>) => Promise<void>;
  /** Close the dialog without starting. */
  handleTriggerDialogClose: () => void;
  /** Stop and clean up the active test run. */
  handleTestRunClose: () => void;
  /** The ID of the running test instance (or null). */
  testRunInstanceId: string | null;
  /**
   * Open the test run viewer for an already-running instance (e.g. launched by the AI Author).
   * Does not start a new run — just switches the UI into test-run view mode.
   */
  openTestRunViewer: (instanceId: string, testWorkflowId: string) => void;
  /**
   * Register an AI-Author-initiated test run WITHOUT opening the viewer or pushing the URL hash.
   * This makes the instance ID available so the Test Run button can show "View Test Run",
   * but does not navigate the user.
   */
  registerActiveTestRun: (instanceId: string, testWorkflowId: string) => void;
  /**
   * Whether there is a registered test run (either user-initiated or AI-Author-initiated)
   * that exists but the viewer is NOT currently open.
   */
  hasRegisteredTestRun: boolean;
  /** The instance ID of the most recently registered test run (AI-Author path). */
  registeredTestRunInstanceId: string | null;
  /** The test workflow ID of the most recently registered test run (AI-Author path). */
  registeredTestRunWorkflowId: string | null;
  /**
   * Open the test run viewer for the currently registered run (from registerActiveTestRun).
   * Equivalent to calling openTestRunViewer with the registered IDs.
   */
  viewActiveTestRun: () => void;
}

export function useTestRun({ definition, effectiveId }: UseTestRunOptions): UseTestRunResult {
  const [testRunInstanceId, setTestRunInstanceId] = useState<string | null>(null);
  const [testRunWorkflowId, setTestRunWorkflowId] = useState<string | null>(null);
  const [testRunStarting, setTestRunStarting] = useState(false);
  const [testRunValidation, setTestRunValidation] = useState<TestRunValidation | null>(null);
  const [testRunTriggerOpen, setTestRunTriggerOpen] = useState(false);
  // AI-Author-initiated run: registered but viewer not yet open
  const [registeredTestRunInstanceId, setRegisteredTestRunInstanceId] = useState<string | null>(null);
  const [registeredTestRunWorkflowId, setRegisteredTestRunWorkflowId] = useState<string | null>(null);

  const deleteWorkflow = useDeleteWorkflow();
  const { data: nodeTypeList } = useNodeTypes();

  const { data: testInstance } = useInstance(testRunInstanceId || '');
  const { data: testStatus } = useInstanceStatus(testRunInstanceId || '');

  // Ref so popstate handler always has current workflow ID
  const testRunWorkflowIdRef = useRef<string | null>(null);
  testRunWorkflowIdRef.current = testRunWorkflowId;

  // Clean up the test workflow when the component unmounts while a test run is active
  useEffect(() => {
    return () => {
      if (testRunWorkflowIdRef.current) {
        deleteWorkflow.mutate(testRunWorkflowIdRef.current);
      }
    };
    // Only run on unmount — eslint-disable-next-line is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTriggerSubmit = useCallback(
    async (payload: Record<string, unknown>) => {
      setTestRunStarting(true);
      try {
        const result = await workflowsApi.testRun(effectiveId, payload);
        setTestRunInstanceId(result.instance.id);
        setTestRunWorkflowId(result.testWorkflowId);
        setTestRunTriggerOpen(false);
        // Push a history entry so the browser back button can exit the test run
        window.history.pushState(null, '', window.location.pathname + TEST_RUN_HASH);
      } catch (err) {
        toast.error(`Failed to start test run: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setTestRunStarting(false);
      }
    },
    [effectiveId],
  );

  const handleTestRunClick = useCallback(async () => {
    const triggerStage = definition?.stages.find((s) => s.type.endsWith('-trigger'));
    const triggerNodeInfo = nodeTypeList?.find((nt) => nt.id === triggerStage?.type);
    const triggerMode = triggerNodeInfo?.triggerMode ?? 'prompt';
    if (triggerMode === 'immediate') {
      // If the trigger type provides a sampleEvent, use it. Otherwise fall back
      // to the generic dialog path (same as 'prompt' mode).
      if (triggerNodeInfo?.hasSampleEvent && triggerStage) {
        try {
          const config = (triggerStage.config ?? {}) as Record<string, unknown>;
          const payload = await nodeTypesApi.sampleEvent(triggerStage.type, config);
          await handleTriggerSubmit(payload);
          return;
        } catch {
          // sampleEvent fetch failed — fall through to dialog
        }
      }
      // No sampleEvent available: open the dialog for manual payload entry
      try {
        const res = await fetch(`/api/draft/${effectiveId}/validate`);
        if (res.ok) {
          const validation = await res.json();
          setTestRunValidation(validation);
        }
      } catch {
        // Don't block test run if validation fails to fetch
      }
      setTestRunTriggerOpen(true);
    } else {
      // Fetch validation results before opening dialog
      try {
        const res = await fetch(`/api/draft/${effectiveId}/validate`);
        if (res.ok) {
          const validation = await res.json();
          setTestRunValidation(validation);
        }
      } catch {
        // Don't block test run if validation fails to fetch
      }
      setTestRunTriggerOpen(true);
    }
  }, [definition, nodeTypeList, handleTriggerSubmit, effectiveId]);

  const handleTriggerDialogClose = useCallback(() => {
    setTestRunTriggerOpen(false);
  }, []);

  /**
   * Open the viewer for an already-running instance (e.g. launched by the AI Author via WS event).
   * Mirrors the state mutations done by handleTriggerSubmit, minus the API call.
   */
  const openTestRunViewer = useCallback((instanceId: string, testWorkflowId: string) => {
    setTestRunInstanceId(instanceId);
    setTestRunWorkflowId(testWorkflowId);
    setTestRunTriggerOpen(false);
    // Clear registered state once viewer is actually opened
    setRegisteredTestRunInstanceId(null);
    setRegisteredTestRunWorkflowId(null);
    window.history.pushState(null, '', window.location.pathname + TEST_RUN_HASH);
  }, []);

  /**
   * Register an AI-Author-initiated test run without opening the viewer.
   * Sets the instance ID so the Test Run button shows "View Test Run",
   * but does NOT push the URL hash or switch into test-run view mode.
   */
  const registerActiveTestRun = useCallback((instanceId: string, testWorkflowId: string) => {
    setRegisteredTestRunInstanceId(instanceId);
    setRegisteredTestRunWorkflowId(testWorkflowId);
  }, []);

  /**
   * Open the viewer for the currently registered AI-Author-initiated test run.
   */
  const viewActiveTestRun = useCallback(() => {
    if (registeredTestRunInstanceId && registeredTestRunWorkflowId) {
      openTestRunViewer(registeredTestRunInstanceId, registeredTestRunWorkflowId);
    } else if (testRunInstanceId && testRunWorkflowId) {
      // Already-open run — no-op (viewer should already be showing)
    }
  }, [registeredTestRunInstanceId, registeredTestRunWorkflowId, testRunInstanceId, testRunWorkflowId, openTestRunViewer]);

  const handleTestRunClose = useCallback(() => {
    if (testRunWorkflowId) {
      deleteWorkflow.mutate(testRunWorkflowId);
    }
    // Clear the ref so the popstate/hashchange handler doesn't double-fire.
    testRunWorkflowIdRef.current = null;
    setTestRunInstanceId(null);
    setTestRunWorkflowId(null);
    // Remove the #test-run hash from the URL
    if (window.location.hash === TEST_RUN_HASH) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [testRunWorkflowId, deleteWorkflow]);

  // Listen for browser back button — if the hash disappears, close the test run.
  // We listen to both popstate and hashchange to cover all browsers/routers.
  useEffect(() => {
    if (!testRunInstanceId) return; // Only listen while a test run is active

    const handleNavigation = () => {
      if (window.location.hash !== TEST_RUN_HASH) {
        if (testRunWorkflowIdRef.current) {
          deleteWorkflow.mutate(testRunWorkflowIdRef.current);
          testRunWorkflowIdRef.current = null;
        }
        setTestRunInstanceId(null);
        setTestRunWorkflowId(null);
      }
    };
    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('hashchange', handleNavigation);
    return () => {
      window.removeEventListener('popstate', handleNavigation);
      window.removeEventListener('hashchange', handleNavigation);
    };
  }, [testRunInstanceId, deleteWorkflow]);

  // Derive triggerSchema from definition for the TriggerDialog
  const isTestActive = !!(testRunInstanceId && testInstance);

  // There is a registered (but not yet viewed) test run if we have a registered instance
  // OR if the user-initiated run is active and the viewer is open (testRunInstanceId set)
  const hasRegisteredTestRun = !!(registeredTestRunInstanceId);

  return {
    isTestActive,
    testInstance,
    testStatus,
    testRunValidation,
    testRunTriggerOpen,
    testRunStarting,
    handleTestRunClick,
    handleTriggerSubmit,
    handleTriggerDialogClose,
    handleTestRunClose,
    testRunInstanceId,
    openTestRunViewer,
    registerActiveTestRun,
    hasRegisteredTestRun,
    registeredTestRunInstanceId,
    registeredTestRunWorkflowId,
    viewActiveTestRun,
  };
}
