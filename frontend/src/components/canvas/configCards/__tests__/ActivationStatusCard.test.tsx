/**
 * Tests for the real ActivationStatusCard (Phase 4).
 *
 * Covers status dot color, status label, counts, and inactive state.
 * Mock the useTriggerStatuses / useTriggerLogs hooks to avoid real fetches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivationStatusCard } from '../ActivationStatusCard';
import type { StageDefinition, WorkflowDefinition } from '../../../../lib/api';

// ---------------------------------------------------------------------------
// Mock the query hooks so tests don't make real HTTP calls
// ---------------------------------------------------------------------------

const mockUseTriggerStatuses = vi.fn();
const mockUseTriggerLogs = vi.fn();

vi.mock('../../../../hooks/queries', () => ({
  useTriggerStatuses: (...args: unknown[]) => mockUseTriggerStatuses(...args),
  useTriggerLogs: (...args: unknown[]) => mockUseTriggerLogs(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockStage: StageDefinition = {
  id: 'cron1',
  type: 'cron-trigger',
  config: { schedule: '5m' },
} as StageDefinition;

const activeWorkflow = {
  id: 'wf-1',
  name: 'Test',
  active: true,
} as WorkflowDefinition;

const inactiveWorkflow = {
  id: 'wf-1',
  name: 'Test',
  active: false,
} as WorkflowDefinition;

const baseProps = {
  card: { kind: 'activation-status' as const, title: 'Trigger Status' },
  stage: mockStage,
  workflowId: 'wf-1',
  apiOrigin: 'https://example.com',
};

function makeStatus(state: 'active' | 'starting' | 'errored' | 'stopped', overrides = {}) {
  return {
    state,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    lastEventAt: state === 'active' ? new Date(Date.now() - 5_000).toISOString() : null,
    lastErrorAt: state === 'errored' ? new Date(Date.now() - 2_000).toISOString() : null,
    lastError: state === 'errored' ? 'Child exited unexpectedly' : null,
    eventCount: state === 'active' ? 5 : 0,
    errorCount: state === 'errored' ? 1 : 0,
    logsPreview: ['[2026-01-01T00:00:00Z] [INFO] activated', '[2026-01-01T00:00:01Z] [INFO] fired'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTriggerLogs.mockReturnValue({ data: undefined, isLoading: false });
});

describe('ActivationStatusCard — inactive workflow', () => {
  it('shows Inactive state when workflow is not active', () => {
    mockUseTriggerStatuses.mockReturnValue({ data: undefined, isLoading: false });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={inactiveWorkflow}
      />,
    );

    expect(screen.getByTestId('trigger-inactive')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });
});

describe('ActivationStatusCard — active state', () => {
  it('shows green dot and Active label', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('active') } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    const dot = screen.getByTestId('trigger-status-dot');
    expect(dot).toHaveAttribute('data-state', 'active');
    expect(dot.className).toContain('bg-green-500');
    expect(screen.getByTestId('trigger-status-label')).toHaveTextContent('Active');
  });

  it('shows event and error counts', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('active', { eventCount: 7, errorCount: 2 }) } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    expect(screen.getByTestId('trigger-counts')).toHaveTextContent('Events: 7 · Errors: 2');
  });
});

describe('ActivationStatusCard — starting state', () => {
  it('shows pulsing blue dot and Starting label', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('starting') } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    const dot = screen.getByTestId('trigger-status-dot');
    expect(dot).toHaveAttribute('data-state', 'starting');
    expect(dot.className).toContain('bg-blue-500');
    expect(screen.getByTestId('trigger-status-label')).toHaveTextContent('Starting');
  });
});

describe('ActivationStatusCard — errored state', () => {
  it('shows red dot, Errored label, and last error message', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('errored') } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    const dot = screen.getByTestId('trigger-status-dot');
    expect(dot).toHaveAttribute('data-state', 'errored');
    expect(dot.className).toContain('bg-red-500');
    expect(screen.getByTestId('trigger-status-label')).toHaveTextContent('Errored');
    expect(screen.getByTestId('trigger-last-error')).toHaveTextContent('Child exited unexpectedly');
  });
});

describe('ActivationStatusCard — stopped state', () => {
  it('shows gray dot and Stopped label', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('stopped') } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    const dot = screen.getByTestId('trigger-status-dot');
    expect(dot).toHaveAttribute('data-state', 'stopped');
    expect(screen.getByTestId('trigger-status-label')).toHaveTextContent('Stopped');
  });
});

describe('ActivationStatusCard — card title', () => {
  it('renders the title prop', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: { cron1: makeStatus('active') } },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        card={{ kind: 'activation-status', title: 'My Trigger Status' }}
        definition={activeWorkflow}
      />,
    );

    expect(screen.getByText('My Trigger Status')).toBeInTheDocument();
  });
});

describe('ActivationStatusCard — not-yet-registered trigger', () => {
  it('shows waiting state when trigger not in statuses map yet', () => {
    mockUseTriggerStatuses.mockReturnValue({
      data: { triggers: {} },
      isLoading: false,
    });

    render(
      <ActivationStatusCard
        {...baseProps}
        definition={activeWorkflow}
      />,
    );

    expect(screen.getByTestId('trigger-not-registered')).toBeInTheDocument();
    expect(screen.getByText('Waiting for activation…')).toBeInTheDocument();
  });
});
