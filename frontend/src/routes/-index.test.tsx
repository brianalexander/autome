/**
 * Tests for the WorkflowsPage Activate button visibility.
 * Phase 1B: button is shown when registry reports hasLifecycle === true.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — must be registered before the module under test is imported
// ---------------------------------------------------------------------------

vi.mock('../hooks/queries', () => ({
  useWorkflows: vi.fn(),
  useNodeTypes: vi.fn(),
  useTriggerWorkflow: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteWorkflow: () => ({ mutate: vi.fn() }),
  useActivateWorkflow: () => ({ mutate: vi.fn() }),
  useDeactivateWorkflow: () => ({ mutate: vi.fn() }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    createFileRoute: () => (opts: { component: React.ComponentType }) => opts,
    Link: ({ children }: { children: React.ReactNode; [key: string]: unknown }) => (
      <a href="#">{children}</a>
    ),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('../components/TriggerDialog', () => ({
  TriggerDialog: () => null,
}));

vi.mock('../components/PromptTriggerDialog', () => ({
  PromptTriggerDialog: () => null,
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    workflows: {
      ...(actual.workflows as object),
      clone: vi.fn(),
    },
    isTriggerType: actual.isTriggerType,
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

// Import mocked hooks and the component AFTER mocks are declared
import { useWorkflows, useNodeTypes } from '../hooks/queries';
import { Route } from './index';

// The mocked createFileRoute returns (opts) => opts, so Route === { component: WorkflowsPage }
const WorkflowsPage = (Route as unknown as { component: React.ComponentType }).component;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeWorkflow(triggerType = 'cron-trigger', active = false) {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: '',
    version: 1,
    active,
    trigger: { provider: 'cron' },
    stages: [
      {
        id: 'trigger-1',
        type: triggerType,
        label: 'Trigger',
        config: { schedule: '5m' },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
}

const cronNodeType = {
  id: 'cron-trigger',
  name: 'Cron Trigger',
  category: 'trigger' as const,
  description: 'Cron trigger',
  icon: 'clock',
  color: { bg: '#f0fdf4', border: '#22c55e', text: '#16a34a' },
  configSchema: {},
  defaultConfig: {},
  executorType: 'trigger' as const,
  triggerMode: 'immediate' as const,
  hasLifecycle: true,
  hasSampleEvent: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowsPage — Activate button (Phase 1B registry-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Activate button when registry reports hasLifecycle === true', () => {
    vi.mocked(useWorkflows).mockReturnValue({
      data: { data: [makeWorkflow()], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflows>);

    vi.mocked(useNodeTypes).mockReturnValue({
      data: [cronNodeType],
    } as unknown as ReturnType<typeof useNodeTypes>);

    render(<WorkflowsPage />);

    expect(screen.getByText('Activate')).toBeInTheDocument();
  });

  it('does NOT show Activate button when node types are not yet loaded', () => {
    vi.mocked(useWorkflows).mockReturnValue({
      data: { data: [makeWorkflow()], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflows>);

    vi.mocked(useNodeTypes).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useNodeTypes>);

    render(<WorkflowsPage />);

    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
  });

  it('does NOT show Activate button when hasLifecycle is false', () => {
    vi.mocked(useWorkflows).mockReturnValue({
      data: { data: [makeWorkflow()], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflows>);

    vi.mocked(useNodeTypes).mockReturnValue({
      data: [{ ...cronNodeType, hasLifecycle: false }],
    } as unknown as ReturnType<typeof useNodeTypes>);

    render(<WorkflowsPage />);

    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
  });

  it('shows Active label (not Activate) when workflow is already active', () => {
    vi.mocked(useWorkflows).mockReturnValue({
      data: { data: [makeWorkflow('cron-trigger', true)], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflows>);

    vi.mocked(useNodeTypes).mockReturnValue({
      data: [cronNodeType],
    } as unknown as ReturnType<typeof useNodeTypes>);

    render(<WorkflowsPage />);

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Activate')).not.toBeInTheDocument();
  });

  it('shows Activate for a plugin trigger type with hasLifecycle === true', () => {
    const pluginTriggerType = {
      ...cronNodeType,
      id: 'my:kafka-trigger',
      name: 'Kafka Trigger',
    };

    vi.mocked(useWorkflows).mockReturnValue({
      data: { data: [makeWorkflow('my:kafka-trigger')], total: 1, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflows>);

    vi.mocked(useNodeTypes).mockReturnValue({
      data: [pluginTriggerType],
    } as unknown as ReturnType<typeof useNodeTypes>);

    render(<WorkflowsPage />);

    expect(screen.getByText('Activate')).toBeInTheDocument();
  });
});
