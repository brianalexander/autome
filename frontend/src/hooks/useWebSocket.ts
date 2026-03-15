import { useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUIStore } from '../stores/uiStore';

interface WSMessage {
  event: string;
  data: unknown;
  timestamp: string;
}

type EventHandler = (data: unknown) => void;

// ---------------------------------------------------------------------------
// Singleton WebSocket connection — shared across all hook instances
// ---------------------------------------------------------------------------
const handlers = new Map<string, Set<EventHandler>>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let queryClientRef: { invalidateQueries: (opts: { queryKey: unknown[] }) => void } | null = null;

/** Channels to re-send on reconnect (populated by hook instances with subscriptions). */
const pendingSubscriptions = new Set<string>();

function sendSubscription(channel: string, type: 'subscribe' | 'unsubscribe') {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, channel }));
  }
}

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    useUIStore.getState().setWsConnected(true);
    // Re-send all active subscriptions after a reconnect
    for (const channel of pendingSubscriptions) {
      ws!.send(JSON.stringify({ type: 'subscribe', channel }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg: WSMessage = JSON.parse(event.data);

      // Auto-invalidate TanStack Query caches
      if (queryClientRef && msg.event.startsWith('instance:')) {
        queryClientRef.invalidateQueries({ queryKey: ['instances'] });
        const data = msg.data as Record<string, unknown>;
        if (data?.instanceId) {
          queryClientRef.invalidateQueries({ queryKey: ['instance', data.instanceId] });
        }
      }

      // Dispatch to registered handlers
      const eventHandlers = handlers.get(msg.event);
      if (eventHandlers) {
        for (const handler of eventHandlers) handler(msg.data);
      }
      const wildcardHandlers = handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) handler(msg);
      }
    } catch (err) {
      console.error('[ws] Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    useUIStore.getState().setWsConnected(false);
    ws = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(ensureConnection, 3000);
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

// ---------------------------------------------------------------------------
// Hook — subscribes to events, ensures singleton connection is alive
// ---------------------------------------------------------------------------

/**
 * @param subscriptions - Optional list of channels to subscribe to (e.g. 'instance:abc123',
 *   'workflow:def456'). When provided the client switches from broadcast mode to
 *   filtered mode — only events for these channels will be received.
 *   Omit (or pass nothing) to keep receiving all events (backward compatible).
 */
export function useWebSocket(subscriptions?: string[]) {
  const queryClient = useQueryClient();

  // Keep queryClient ref current for the singleton
  useEffect(() => {
    queryClientRef = queryClient;
  }, [queryClient]);

  // Ensure connection on mount (idempotent)
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      ensureConnection();
    }
  }, []);

  // Manage channel subscriptions — send subscribe/unsubscribe as channels change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subscriptionsKey = subscriptions?.join(',') ?? '';
  const prevSubscriptionsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!subscriptions || subscriptions.length === 0) return;

    const prev = new Set(prevSubscriptionsRef.current);
    const next = new Set(subscriptions);

    for (const channel of next) {
      if (!prev.has(channel)) {
        pendingSubscriptions.add(channel);
        sendSubscription(channel, 'subscribe');
      }
    }

    for (const channel of prev) {
      if (!next.has(channel)) {
        pendingSubscriptions.delete(channel);
        sendSubscription(channel, 'unsubscribe');
      }
    }

    prevSubscriptionsRef.current = subscriptions;

    return () => {
      for (const channel of next) {
        pendingSubscriptions.delete(channel);
        sendSubscription(channel, 'unsubscribe');
      }
      prevSubscriptionsRef.current = [];
    };
    // subscriptionsKey is a stable string-join of the array — safe dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionsKey]);

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlers.has(event)) {
      handlers.set(event, new Set());
    }
    handlers.get(event)!.add(handler);

    return () => {
      handlers.get(event)?.delete(handler);
    };
  }, []);

  return { on };
}
