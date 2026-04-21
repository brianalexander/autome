import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

type ReviewDecision = 'approved' | 'revised' | 'rejected';

interface ReviewGateActionsProps {
  instanceId: string;
  stageId: string;
  onSubmitted?: (decision: ReviewDecision) => void;
}

async function submitReview(
  instanceId: string,
  stageId: string,
  decision: ReviewDecision,
  notes: string,
): Promise<{ submitted: boolean; decision: ReviewDecision }> {
  const res = await fetch(`/api/instances/${instanceId}/stages/${stageId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, notes: notes.trim() || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export function ReviewGateActions({ instanceId, stageId, onSubmitted }: ReviewGateActionsProps) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState('');
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null);

  const mutation = useMutation({
    mutationFn: ({ decision }: { decision: ReviewDecision }) =>
      submitReview(instanceId, stageId, decision, notes),
    onSuccess: (_, { decision }) => {
      queryClient.invalidateQueries({ queryKey: ['instance', instanceId] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['instances'] });
      const labels: Record<ReviewDecision, string> = {
        approved: 'Review approved',
        revised: 'Revision requested',
        rejected: 'Review rejected',
      };
      toast.success(labels[decision]);
      onSubmitted?.(decision);
    },
    onError: (err: Error) => toast.error(`Failed to submit review: ${err.message}`),
    onSettled: () => setPendingDecision(null),
  });

  const handleDecision = useCallback(
    (decision: ReviewDecision) => {
      setPendingDecision(decision);
      mutation.mutate({ decision });
    },
    [mutation],
  );

  const isPending = mutation.isPending;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-[10px] text-text-tertiary uppercase tracking-wider">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Optional notes for the requester..."
          disabled={isPending}
          className="w-full bg-surface-secondary border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500 resize-y disabled:opacity-50"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => handleDecision('approved')}
          disabled={isPending}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {isPending && pendingDecision === 'approved' ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={() => handleDecision('revised')}
          disabled={isPending}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {isPending && pendingDecision === 'revised' ? 'Sending...' : 'Request Revision'}
        </button>
        <button
          onClick={() => handleDecision('rejected')}
          disabled={isPending}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {isPending && pendingDecision === 'rejected' ? 'Rejecting...' : 'Reject'}
        </button>
      </div>
    </div>
  );
}
