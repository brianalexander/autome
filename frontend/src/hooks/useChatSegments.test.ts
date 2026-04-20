import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useChatSegments } from './useChatSegments';
import type { SegmentRecord } from '../lib/api';

// Factory for a minimal SegmentRecord
function makeSeg(content: string): SegmentRecord {
  return {
    id: 1,
    segment_index: 0,
    segment_type: 'text',
    content,
    tool_call: null,
    created_at: '2024-01-01T00:00:00.000Z',
  };
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useChatSegments', () => {
  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------
  it('populates initialMessages when queryFn returns segments', async () => {
    const qc = freshClient();
    const wrapper = makeWrapper(qc);
    const segs = [makeSeg('hello')];
    const { result } = renderHook(
      () => useChatSegments(['segs-happy'], () => Promise.resolve(segs)),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.initialMessages).toBeDefined();
    expect(result.current.initialMessages).toHaveLength(1);
    expect(result.current.initialMessages![0].role).toBe('assistant');
    expect(result.current.initialMessages![0].content).toBe('hello');
  });

  // ---------------------------------------------------------------------------
  // 2. Empty segments
  // ---------------------------------------------------------------------------
  it('returns initialMessages as undefined when queryFn returns an empty array', async () => {
    const qc = freshClient();
    const wrapper = makeWrapper(qc);
    const { result } = renderHook(
      () => useChatSegments(['segs-empty'], () => Promise.resolve([])),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.initialMessages).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 3. Disabled
  // ---------------------------------------------------------------------------
  it('does not call queryFn when enabled is false', async () => {
    const qc = freshClient();
    const wrapper = makeWrapper(qc);
    let calls = 0;
    const qf = () => { calls++; return Promise.resolve([makeSeg('should not appear')]); };

    const { result } = renderHook(
      () => useChatSegments(['segs-disabled'], qf, { enabled: false }),
      { wrapper },
    );

    // Give it time to potentially fire
    await new Promise((res) => setTimeout(res, 50));

    expect(calls).toBe(0);
    expect(result.current.initialMessages).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Remount-safe policy lock-in
  //    Both mounts must trigger a fetch — stale cache must NOT be served silently.
  // ---------------------------------------------------------------------------
  it('refetches on remount (staleTime: 0, refetchOnMount: always)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = makeWrapper(qc);

    let calls = 0;
    const qf = () => {
      calls++;
      return Promise.resolve([makeSeg('hi')]);
    };

    // First mount
    const first = renderHook(
      () => useChatSegments(['segs-remount'], qf),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(calls).toBe(1);

    first.unmount();

    // Second mount — must fire again despite the cache entry being populated
    const second = renderHook(
      () => useChatSegments(['segs-remount'], qf),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.data).toBeDefined());

    // Without staleTime: 0 + refetchOnMount: 'always', this would be 1.
    expect(calls).toBe(2);
  });
});
