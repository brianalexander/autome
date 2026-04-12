/**
 * useTestRunCompletionToast — subscribes to author:test_run_completed WS events
 * and shows a sonner toast when the user is NOT already on the owning workflow page.
 */
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useWebSocket } from './useWebSocket';

interface TestRunCompletedEvent {
  workflowId?: string;
  instanceId?: string;
  status?: string;
  summary?: string;
}

export function useTestRunCompletionToast() {
  const { on } = useWebSocket();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const unsub = on('author:test_run_completed', (data: unknown) => {
      const d = data as TestRunCompletedEvent;
      if (!d.workflowId) return;

      // Check if user is already on this workflow's page
      const onWorkflowPage = location.pathname.includes(d.workflowId);
      if (onWorkflowPage) return;

      const label = d.status === 'completed' ? 'Test run completed' : `Test run ${d.status ?? 'finished'}`;
      const summary = d.summary ?? '';

      const action = {
        label: 'View',
        onClick: () =>
          navigate({ to: '/workflows/$workflowId', params: { workflowId: d.workflowId! } }),
      };

      if (d.status === 'completed') {
        toast.success(label, {
          description: summary || undefined,
          action,
          duration: 8000,
        });
      } else {
        toast.error(label, {
          description: summary || undefined,
          action,
          duration: 8000,
        });
      }
    });
    return unsub;
  }, [on, location.pathname, navigate]);
}
