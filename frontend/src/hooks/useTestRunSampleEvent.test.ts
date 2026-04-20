/**
 * Tests for the Phase 2E sampleEvent branch in useTestRun.
 * Verifies that handleTestRunClick uses the sampleEvent endpoint for
 * 'immediate'-mode triggers that advertise hasSampleEvent: true.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the hook so the module sees the mocks
// ---------------------------------------------------------------------------

// State holder for useNodeTypes — mutated per test
const mockState = {
  nodeTypeList: [] as unknown[],
};

vi.mock('./queries', () => ({
  useDeleteWorkflow: () => ({ mutate: vi.fn() }),
  useInstance: () => ({ data: undefined }),
  useInstanceStatus: () => ({ data: undefined }),
  useNodeTypes: () => ({ data: mockState.nodeTypeList }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    workflows: {
      ...((actual as Record<string, unknown>).workflows as object),
      testRun: vi.fn(),
    },
    nodeTypes: {
      list: vi.fn(),
      sampleEvent: vi.fn(),
    },
    isTriggerType: actual.isTriggerType,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// Import hook and api AFTER mocks are registered
import { useTestRun } from './useTestRun';
import * as apiModule from '../lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cronTriggerNodeInfo = {
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

const cronTriggerNodeInfoNoSample = {
  ...cronTriggerNodeInfo,
  hasSampleEvent: false,
};

const definitionWithCronTrigger = {
  id: 'wf-cron',
  name: 'Cron WF',
  description: '',
  version: 1,
  active: true,
  trigger: { provider: 'cron' as const },
  stages: [
    {
      id: 'trigger-stage',
      type: 'cron-trigger',
      label: 'Cron Trigger',
      config: { schedule: '5m' },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useTestRun — sampleEvent branch (Phase 2E)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
    // Default: return cron trigger info with sampleEvent
    mockState.nodeTypeList = [cronTriggerNodeInfo];
    // Default: testRun succeeds
    vi.mocked(apiModule.workflows.testRun).mockResolvedValue(
      { instance: { id: 'inst-1' }, testWorkflowId: 'test-wf-1' } as Awaited<ReturnType<typeof apiModule.workflows.testRun>>,
    );
  });

  it('calls sampleEvent endpoint and uses payload when hasSampleEvent is true', async () => {
    const samplePayload = { type: 'cron', timestamp: '2024-01-01T00:00:00.000Z', schedule: '5m' };
    vi.mocked(apiModule.nodeTypes.sampleEvent).mockResolvedValue(samplePayload);

    const { result } = renderHook(() =>
      useTestRun({ definition: definitionWithCronTrigger, effectiveId: 'wf-cron' }),
    );

    await act(async () => {
      await result.current.handleTestRunClick();
    });

    expect(apiModule.nodeTypes.sampleEvent).toHaveBeenCalledWith('cron-trigger', { schedule: '5m' });
    expect(apiModule.workflows.testRun).toHaveBeenCalledWith('wf-cron', samplePayload);
    // Viewer should now be active (no dialog needed)
    expect(result.current.testRunTriggerOpen).toBe(false);
  });

  it('opens dialog when sampleEvent endpoint throws (graceful fallback)', async () => {
    vi.mocked(apiModule.nodeTypes.sampleEvent).mockRejectedValue(new Error('network error'));
    // Mock fetch for validation
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const { result } = renderHook(() =>
      useTestRun({ definition: definitionWithCronTrigger, effectiveId: 'wf-cron' }),
    );

    await act(async () => {
      await result.current.handleTestRunClick();
    });

    // Should fall through to dialog on sampleEvent error
    expect(result.current.testRunTriggerOpen).toBe(true);
    // testRun should NOT have been called
    expect(apiModule.workflows.testRun).not.toHaveBeenCalled();
  });

  it('opens dialog when hasSampleEvent is false (no endpoint call)', async () => {
    mockState.nodeTypeList = [cronTriggerNodeInfoNoSample];
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const { result } = renderHook(() =>
      useTestRun({ definition: definitionWithCronTrigger, effectiveId: 'wf-cron' }),
    );

    await act(async () => {
      await result.current.handleTestRunClick();
    });

    expect(apiModule.nodeTypes.sampleEvent).not.toHaveBeenCalled();
    expect(result.current.testRunTriggerOpen).toBe(true);
  });
});
