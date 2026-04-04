import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { useDeleteWorkflow, useInstance, useInstanceStatus, useNodeTypes } from './queries';
import { workflows as workflowsApi, isTriggerType, type WorkflowDefinition } from '../lib/api';

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
}

export function useTestRun({ definition, effectiveId }: UseTestRunOptions): UseTestRunResult {
  const [testRunInstanceId, setTestRunInstanceId] = useState<string | null>(null);
  const [testRunWorkflowId, setTestRunWorkflowId] = useState<string | null>(null);
  const [testRunStarting, setTestRunStarting] = useState(false);
  const [testRunValidation, setTestRunValidation] = useState<TestRunValidation | null>(null);
  const [testRunTriggerOpen, setTestRunTriggerOpen] = useState(false);

  const deleteWorkflow = useDeleteWorkflow();
  const { data: nodeTypeList } = useNodeTypes();

  const { data: testInstance } = useInstance(testRunInstanceId || '');
  const { data: testStatus } = useInstanceStatus(testRunInstanceId || '');

  // Clean up the test workflow when the component unmounts while a test run is active
  useEffect(() => {
    return () => {
      if (testRunWorkflowId) {
        deleteWorkflow.mutate(testRunWorkflowId);
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
      await handleTriggerSubmit({ source: 'cron', scheduled_at: new Date().toISOString() });
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

  const handleTestRunClose = useCallback(() => {
    if (testRunWorkflowId) {
      deleteWorkflow.mutate(testRunWorkflowId);
    }
    setTestRunInstanceId(null);
    setTestRunWorkflowId(null);
  }, [testRunWorkflowId, deleteWorkflow]);

  // Derive triggerSchema from definition for the TriggerDialog
  const isTestActive = !!(testRunInstanceId && testInstance);

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
  };
}
