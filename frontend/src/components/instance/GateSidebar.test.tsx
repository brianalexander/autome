import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GateSidebar } from './GateSidebar';
import type { StageDefinition, StageContext, WorkflowDefinition } from '../../lib/api';

// Mock ReviewGateActions so we can assert its presence without query providers
vi.mock('../review/ReviewGateActions', () => ({
  ReviewGateActions: ({ instanceId, stageId }: { instanceId: string; stageId: string }) => (
    <div data-testid="review-gate-actions" data-instance-id={instanceId} data-stage-id={stageId}>
      <button>Approve</button>
      <button>Request Revision</button>
      <button>Reject</button>
    </div>
  ),
}));

// Mock ConfigPanel to avoid canvas deps
vi.mock('../canvas/ConfigPanel', () => ({
  ConfigPanel: () => <div data-testid="config-panel">Config Panel</div>,
}));

const baseDefinition: WorkflowDefinition = {
  id: 'wf-1',
  name: 'Test Workflow',
  active: true,
  trigger: { provider: 'manual' },
  stages: [],
  edges: [],
};

const waitingStageCtx: StageContext = {
  status: 'running',
  run_count: 1,
  runs: [],
};

const defaultProps = {
  instanceId: 'inst-1',
  stageId: 'review1',
  stageCtx: waitingStageCtx,
  definition: baseDefinition,
  workflowContext: {},
  onClose: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

describe('GateSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ReviewGateActions when stage type is review-gate and waiting', () => {
    const reviewStageDef: StageDefinition = {
      id: 'review1',
      type: 'review-gate',
      config: { message: 'Please review' },
    };

    render(<GateSidebar {...defaultProps} stageDef={reviewStageDef} />);

    expect(screen.getByTestId('review-gate-actions')).toBeInTheDocument();
    expect(screen.getByTestId('review-gate-actions')).toHaveAttribute('data-instance-id', 'inst-1');
    expect(screen.getByTestId('review-gate-actions')).toHaveAttribute('data-stage-id', 'review1');
  });

  it('does NOT render ReviewGateActions for binary gate type', () => {
    const gateStageDef: StageDefinition = {
      id: 'gate1',
      type: 'gate',
      config: { type: 'manual', message: 'Approve this' },
    };

    render(
      <GateSidebar
        {...defaultProps}
        stageId="gate1"
        stageDef={gateStageDef}
      />
    );

    expect(screen.queryByTestId('review-gate-actions')).not.toBeInTheDocument();
    // Binary gate should show Approve/Reject buttons from GateSidebar itself
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
  });

  it('does NOT render ReviewGateActions when review-gate is not waiting', () => {
    const reviewStageDef: StageDefinition = {
      id: 'review1',
      type: 'review-gate',
      config: { message: 'Please review' },
    };

    const completedCtx: StageContext = {
      status: 'completed',
      run_count: 1,
      runs: [],
    };

    render(
      <GateSidebar
        {...defaultProps}
        stageDef={reviewStageDef}
        stageCtx={completedCtx}
      />
    );

    expect(screen.queryByTestId('review-gate-actions')).not.toBeInTheDocument();
  });

  it('renders review-gate label in header', () => {
    const reviewStageDef: StageDefinition = {
      id: 'review1',
      type: 'review-gate',
      label: 'My Review Gate',
      config: { message: 'Please review' },
    };

    render(<GateSidebar {...defaultProps} stageDef={reviewStageDef} />);
    expect(screen.getByText('My Review Gate')).toBeInTheDocument();
  });
});
