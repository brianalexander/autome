/**
 * Tests for the author:test_run_started WS-driven path in useTestRun.
 * Verifies that openTestRunViewer sets testRunInstanceId correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTestRun } from './useTestRun';

// ---------------------------------------------------------------------------
// Mock heavy deps that would require a full React Query provider tree
// ---------------------------------------------------------------------------
vi.mock('./queries', () => ({
  useDeleteWorkflow: () => ({ mutate: vi.fn() }),
  useInstance: () => ({ data: undefined }),
  useInstanceStatus: () => ({ data: undefined }),
  useNodeTypes: () => ({ data: [] }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    workflows: {
      ...((actual as Record<string, unknown>).workflows as object),
      testRun: vi.fn(),
    },
    isTriggerType: actual.isTriggerType,
  };
});

// useQueryClient is needed by useDeleteWorkflow internally (mocked above), but
// renderHook wraps without a provider, so mock it at the hook level too.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

const minimalDefinition = {
  id: 'wf-1',
  name: 'Test',
  description: '',
  version: 1,
  active: true,
  trigger: { provider: 'manual' as const },
  stages: [],
  edges: [],
};

describe('useTestRun — openTestRunViewer', () => {
  beforeEach(() => {
    // Reset URL
    window.history.replaceState(null, '', '/');
  });

  it('sets testRunInstanceId when openTestRunViewer is called', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    expect(result.current.testRunInstanceId).toBeNull();

    act(() => {
      result.current.openTestRunViewer('instance-abc', 'test-wf-xyz');
    });

    expect(result.current.testRunInstanceId).toBe('instance-abc');
  });

  it('adds #test-run to the URL when openTestRunViewer is called', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    act(() => {
      result.current.openTestRunViewer('instance-abc', 'test-wf-xyz');
    });

    expect(window.location.hash).toBe('#test-run');
  });

  it('closes the trigger dialog when openTestRunViewer is called', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    // testRunTriggerOpen starts false; openTestRunViewer should leave it false
    act(() => {
      result.current.openTestRunViewer('instance-abc', 'test-wf-xyz');
    });

    expect(result.current.testRunTriggerOpen).toBe(false);
  });
});

describe('useTestRun — registerActiveTestRun (AI-Author-initiated path)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('sets registeredTestRunInstanceId without pushing URL hash', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    expect(result.current.registeredTestRunInstanceId).toBeNull();

    act(() => {
      result.current.registerActiveTestRun('instance-ai-1', 'test-wf-ai-1');
    });

    expect(result.current.registeredTestRunInstanceId).toBe('instance-ai-1');
    // URL hash must NOT be pushed
    expect(window.location.hash).toBe('');
  });

  it('does NOT set testRunInstanceId (does not switch to test-run view mode)', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    act(() => {
      result.current.registerActiveTestRun('instance-ai-1', 'test-wf-ai-1');
    });

    // testRunInstanceId must remain null — viewer NOT opened
    expect(result.current.testRunInstanceId).toBeNull();
    // isTestActive should be false (no viewer open)
    expect(result.current.isTestActive).toBe(false);
  });

  it('sets hasRegisteredTestRun to true when a run is registered', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    expect(result.current.hasRegisteredTestRun).toBe(false);

    act(() => {
      result.current.registerActiveTestRun('instance-ai-1', 'test-wf-ai-1');
    });

    expect(result.current.hasRegisteredTestRun).toBe(true);
  });

  it('viewActiveTestRun opens the viewer and clears registered state', () => {
    const { result } = renderHook(() =>
      useTestRun({ definition: minimalDefinition, effectiveId: 'wf-1' }),
    );

    act(() => {
      result.current.registerActiveTestRun('instance-ai-1', 'test-wf-ai-1');
    });

    expect(result.current.hasRegisteredTestRun).toBe(true);

    act(() => {
      result.current.viewActiveTestRun();
    });

    // Viewer opened: testRunInstanceId now set, hash pushed
    expect(result.current.testRunInstanceId).toBe('instance-ai-1');
    expect(window.location.hash).toBe('#test-run');
    // Registered state cleared
    expect(result.current.hasRegisteredTestRun).toBe(false);
  });
});
