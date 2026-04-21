import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewGateActions } from './ReviewGateActions';

// Mock @tanstack/react-query
const mockMutate = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: ({ onSuccess, onError, onSettled }: {
    mutationFn: (v: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown, vars: unknown) => void;
    onError?: (err: Error) => void;
    onSettled?: () => void;
  }) => ({
    mutate: (vars: unknown) => {
      mockMutate(vars);
      // Simulate async call to onSuccess with approved decision
      Promise.resolve({ submitted: true, decision: (vars as { decision: string }).decision }).then((data) => {
        onSuccess?.(data, vars);
        onSettled?.();
      });
    },
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ReviewGateActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders three decision buttons', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);

    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request revision/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('renders the notes textarea', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    expect(screen.getByPlaceholderText(/optional notes/i)).toBeInTheDocument();
  });

  it('calls mutate with approved decision when Approve is clicked', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(mockMutate).toHaveBeenCalledWith({ decision: 'approved' });
  });

  it('calls mutate with revised decision when Request Revision is clicked', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    expect(mockMutate).toHaveBeenCalledWith({ decision: 'revised' });
  });

  it('calls mutate with rejected decision when Reject is clicked', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(mockMutate).toHaveBeenCalledWith({ decision: 'rejected' });
  });

  it('includes notes textarea value in the mutation', () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    const notesArea = screen.getByPlaceholderText(/optional notes/i);
    fireEvent.change(notesArea, { target: { value: 'Please fix the formatting' } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(mockMutate).toHaveBeenCalledWith({ decision: 'approved' });
  });

  it('calls onSubmitted callback after successful submission', async () => {
    const onSubmitted = vi.fn();
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" onSubmitted={onSubmitted} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith('approved');
    });
  });

  it('invalidates approvals and instance queries on success', async () => {
    render(<ReviewGateActions instanceId="inst-1" stageId="review1" />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['approvals'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['instance', 'inst-1'] });
    });
  });
});
