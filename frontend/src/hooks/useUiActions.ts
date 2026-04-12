/**
 * useUiActions — subscribes to `ui:action` WebSocket events and dispatches
 * them to the appropriate frontend handler.
 *
 * Mount this inside WorkflowEditor so it has direct access to useTestRun state.
 * When the Assistant agent comes online in Phase 4, this may be promoted to a
 * global controller.
 */
import { useEffect, type RefObject } from 'react';
import { toast } from 'sonner';
import type { WorkflowCanvasHandle } from '../components/canvas/WorkflowCanvas';

type NavigateFn = (opts: { to: string }) => void;

export interface UiActionsOptions {
  /** The workflow ID of the currently open editor session. */
  currentWorkflowId: string;
  /** Subscribe to a WebSocket event. Returns an unsubscribe function. */
  on: (event: string, handler: (data: unknown) => void) => () => void;
  /** Open the test run viewer for a specific instance. */
  openTestRunViewer: (instanceId: string, testWorkflowId: string) => void;
  /** TanStack Router navigate function for the `navigate` action. */
  navigate?: NavigateFn;
  /** Ref to the imperative canvas handle for the `highlight_element` action. */
  canvasHandle?: RefObject<WorkflowCanvasHandle | null>;
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

export function useUiActions({
  currentWorkflowId,
  on,
  openTestRunViewer,
  navigate,
  canvasHandle,
}: UiActionsOptions): void {
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
          if (!payload.to) {
            console.warn('[useUiActions] navigate action missing `to`', payload);
            return;
          }
          if (navigate) {
            navigate({ to: payload.to });
          } else {
            console.warn('[useUiActions] navigate called but no navigate function provided', payload);
          }
          break;
        }
        case 'highlight_element': {
          if (!payload.elementId) {
            console.warn('[useUiActions] highlight_element missing elementId', payload);
            return;
          }
          // Try canvas node first
          if (canvasHandle?.current?.highlightNode) {
            canvasHandle.current.highlightNode(payload.elementId, payload.pulseMs);
          } else {
            // Fallback: scroll to a DOM element with that id
            document.getElementById(payload.elementId)?.scrollIntoView({ behavior: 'smooth' });
          }
          break;
        }
        case 'toast': {
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
  }, [on, currentWorkflowId, openTestRunViewer, navigate, canvasHandle]);
}
