import { useEffect } from 'react';
import { toast } from 'sonner';
import type { WorkflowCanvasHandle } from '../components/canvas/WorkflowCanvas';

type NavigateFn = (opts: { to: string }) => void;
type OpenTestRunFn = (instanceId: string, testWorkflowId: string) => void;

interface UiCapabilities {
  canvasHandle?: React.RefObject<WorkflowCanvasHandle | null>;
  openTestRunViewer?: OpenTestRunFn;
  /** The workflow ID of the currently active editor, if any */
  activeWorkflowId?: string;
}

// Module-level registry — components register/unregister capabilities
let _capabilities: UiCapabilities = {};

export function registerUiCapabilities(caps: Partial<UiCapabilities>) {
  _capabilities = { ..._capabilities, ...caps };
}

export function unregisterUiCapabilities(keys: (keyof UiCapabilities)[]) {
  for (const key of keys) {
    delete _capabilities[key];
  }
}

/**
 * Single global hook mounted in __root.tsx. Handles ALL ui:action events.
 */
export function useGlobalUiActions(
  on: (event: string, handler: (data: unknown) => void) => () => void,
  navigate: NavigateFn,
) {
  useEffect(() => {
    const unsub = on('ui:action', (data: unknown) => {
      const p = data as {
        action?: string;
        workflowId?: string;
        instanceId?: string;
        testWorkflowId?: string;
        to?: string;
        elementId?: string;
        pulseMs?: number;
        level?: string;
        text?: string;
      };

      // If scoped to a workflow, only handle if it matches the active editor
      if (p.workflowId && _capabilities.activeWorkflowId && p.workflowId !== _capabilities.activeWorkflowId) {
        return;
      }

      switch (p.action) {
        case 'navigate':
          if (p.to) navigate({ to: p.to });
          break;

        case 'toast':
          if (p.text) {
            if (p.level === 'error') toast.error(p.text);
            else if (p.level === 'warn') toast.warning(p.text);
            else if (p.level === 'success') toast.success(p.text);
            else toast.info(p.text);
          }
          break;

        case 'highlight_element':
          if (p.elementId) {
            // Canvas-aware highlight if available
            if (_capabilities.canvasHandle?.current?.highlightNode) {
              _capabilities.canvasHandle.current.highlightNode(p.elementId, p.pulseMs);
            } else {
              // DOM fallback with delay for navigation to settle
              setTimeout(() => {
                document.getElementById(p.elementId!)?.scrollIntoView({ behavior: 'smooth' });
              }, 500);
            }
          }
          break;

        case 'show_test_run':
          if (p.instanceId && p.testWorkflowId && _capabilities.openTestRunViewer) {
            _capabilities.openTestRunViewer(p.instanceId, p.testWorkflowId);
          }
          break;

        default:
          console.warn('[ui:action] Unknown action:', p.action);
      }
    });
    return unsub;
  }, [on, navigate]);
}
