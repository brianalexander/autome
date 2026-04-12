/**
 * useUiActions — subscribes to `ui:action` WebSocket events and dispatches
 * them to the appropriate frontend handler.
 *
 * Mount this inside WorkflowEditor so it has direct access to useTestRun state.
 * When the Assistant agent comes online in Phase 4, this may be promoted to a
 * global controller.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';

export interface UiActionsOptions {
  /** The workflow ID of the currently open editor session. */
  currentWorkflowId: string;
  /** Subscribe to a WebSocket event. Returns an unsubscribe function. */
  on: (event: string, handler: (data: unknown) => void) => () => void;
  /** Open the test run viewer for a specific instance. */
  openTestRunViewer: (instanceId: string, testWorkflowId: string) => void;
}

interface UiActionPayload {
  workflowId?: string;
  action: 'show_test_run' | 'navigate' | 'highlight_element' | 'toast';
  instanceId?: string;
  testWorkflowId?: string;
  to?: string;
  elementId?: string;
  pulseMs?: number;
  level?: 'info' | 'warn' | 'error';
  text?: string;
}

export function useUiActions({ currentWorkflowId, on, openTestRunViewer }: UiActionsOptions): void {
  useEffect(() => {
    const unsub = on('ui:action', (data: unknown) => {
      const payload = data as UiActionPayload;

      // Filter by workflowId if provided (scope to the active editor session)
      if (payload.workflowId && payload.workflowId !== currentWorkflowId) return;

      switch (payload.action) {
        case 'show_test_run': {
          if (!payload.instanceId || !payload.testWorkflowId) {
            console.warn('[useUiActions] show_test_run missing instanceId or testWorkflowId', payload);
            return;
          }
          openTestRunViewer(payload.instanceId, payload.testWorkflowId);
          break;
        }
        case 'navigate': {
          // TODO: implement navigate action (frontend routing)
          console.warn('[useUiActions] navigate action not yet implemented', payload);
          break;
        }
        case 'highlight_element': {
          // TODO: implement highlight_element action (CSS pulse by id)
          console.warn('[useUiActions] highlight_element action not yet implemented', payload);
          break;
        }
        case 'toast': {
          // TODO: implement full toast routing with level/text (basic impl below)
          const msg = payload.text ?? 'Notification';
          if (payload.level === 'error') toast.error(msg);
          else if (payload.level === 'warn') toast.warning(msg);
          else toast.info(msg);
          break;
        }
        default: {
          console.warn('[useUiActions] Unknown ui:action:', payload);
        }
      }
    });
    return unsub;
  }, [on, currentWorkflowId, openTestRunViewer]);
}
