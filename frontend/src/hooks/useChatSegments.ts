import { useMemo } from 'react';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type { SegmentRecord } from '../lib/api';
import { segmentsToMessages } from '../lib/segmentsToMessages';

/**
 * Loads persisted ACP chat segments with a remount-safe cache policy and
 * derives the initialMessages array that AcpChatPane expects.
 *
 * Remount-safe means: on every mount, the query is considered stale and
 * refetched. This guarantees that if a chunk was persisted to the DB while
 * the chat pane was unmounted (e.g. user closed the sidebar mid-stream),
 * the remount sees it — react-query's default caching would otherwise
 * serve the pre-unmount snapshot.
 *
 * All three ACP chat panes (AI Author, Assistant, Agent-stage viewer) must
 * use this hook so the policy can't drift. Endpoint differences are passed
 * in via queryFn; the caching policy is fixed inside.
 */
export function useChatSegments(
  queryKey: QueryKey,
  queryFn: () => Promise<SegmentRecord[]>,
  options: { enabled?: boolean } = {},
) {
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: options.enabled ?? true,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const initialMessages = useMemo(() => {
    if (!query.data?.length) return undefined;
    return segmentsToMessages(query.data);
  }, [query.data]);

  return { ...query, initialMessages };
}
