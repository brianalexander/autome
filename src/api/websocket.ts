/**
 * WebSocket broadcast event types:
 *
 * Lifecycle events (broadcast directly):
 *   instance:created         — New workflow instance created
 *   instance:updated         — Instance status/context changed
 *   instance:cancelled       — Instance cancelled by user
 *   instance:stage_completed — A workflow stage finished successfully
 *   instance:stage_failed    — A workflow stage encountered an error
 *   instance:gate_approved   — Human gate approved
 *   instance:gate_rejected   — Human gate rejected
 *
 * ACP streaming events (prefixed with "agent:" or "author:"):
 *   {prefix}:chunk           — Incremental text chunk from agent
 *   {prefix}:tool_call       — Agent invoked a tool
 *   {prefix}:tool_result     — Tool execution result
 *   {prefix}:tools_swept     — Batch status update for pending tool calls
 *   {prefix}:context_usage   — Context window usage percentage
 *   {prefix}:mcp_status      — MCP server ready/failed notification
 *   {prefix}:done            — Agent turn completed
 *   {prefix}:cancelled       — Agent session cancelled
 *   {prefix}:error           — Agent session error
 *   {prefix}:user_message    — User follow-up message sent to agent
 *   {prefix}:session_status  — Session status change (e.g. pending_restart)
 *
 * Agent-specific events:
 *   agent:status             — Agent progress status update
 *   agent:input_requested    — Agent requests human input
 *
 * Author-specific events:
 *   author:draft             — Workflow definition draft from authoring agent
 *   author:cancelled         — Authoring session cancelled
 *   author:session_status    — Author session status change
 *
 * Coalesced streaming (via broadcastRaw):
 *   acp:segment              — Batched text/tool segments (1ms debounce)
 *
 * Naming convention: entity:action (e.g. instance:created, agent:chunk)
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Client subscription tracking
// ---------------------------------------------------------------------------

interface WsClient {
  socket: WebSocket;
  /**
   * Channels this client is subscribed to. Special values:
   *   'all'              — receive every broadcast (default until first subscribe)
   *   'instance:<id>'    — receive events for a specific instance
   *   'workflow:<id>'    — receive events for all instances of a workflow
   */
  subscriptions: Set<string>;
}

const clients = new Map<WebSocket, WsClient>();

export async function websocketPlugin(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    // New clients start in 'all' mode — backward compatible with existing consumers
    const client: WsClient = { socket, subscriptions: new Set(['all']) };
    clients.set(socket, client);
    (socket as unknown as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true); // Disable Nagle for low-latency streaming
    console.log(`WebSocket client connected (${clients.size} total)`);

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
          // First explicit subscription switches the client from broadcast to filtered mode
          client.subscriptions.delete('all');
          client.subscriptions.add(msg.channel);
        } else if (msg.type === 'unsubscribe' && typeof msg.channel === 'string') {
          client.subscriptions.delete(msg.channel);
          // If no subscriptions remain, fall back to 'all' so the client still receives events
          if (client.subscriptions.size === 0) {
            client.subscriptions.add('all');
          }
        }
      } catch {
        /* ignore non-JSON messages */
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      console.log(`WebSocket client disconnected (${clients.size} total)`);
    });

    socket.on('error', (err) => {
      console.error('WebSocket error:', err);
      clients.delete(socket);
    });
  });
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

/** Optional scope used to filter which subscribed clients receive the message. */
export interface BroadcastScope {
  instanceId?: string;
  workflowId?: string;
}

/**
 * Serialize and send an event to all clients that are interested in the given scope.
 *
 * - No scope → system-level event sent to all clients (backward compatible).
 * - With scope → only clients subscribed to 'all', 'instance:<id>', or 'workflow:<id>'
 *   receive the message.
 */
export function broadcast(event: string, data: unknown, scope?: BroadcastScope): void {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  broadcastRaw(message, scope);
}

/** Send pre-serialized JSON to clients, optionally filtered by scope. */
export function broadcastRaw(json: string, scope?: BroadcastScope): void {
  for (const [, client] of clients) {
    if (client.socket.readyState !== 1 /* WebSocket.OPEN */) continue;

    // No scope — system event, send to everyone
    if (!scope) {
      client.socket.send(json);
      continue;
    }

    // Clients subscribed to 'all' always receive scoped events
    if (client.subscriptions.has('all')) {
      client.socket.send(json);
      continue;
    }

    // Instance-level subscription
    if (scope.instanceId && client.subscriptions.has(`instance:${scope.instanceId}`)) {
      client.socket.send(json);
      continue;
    }

    // Workflow-level subscription (receives events for all instances of that workflow)
    if (scope.workflowId && client.subscriptions.has(`workflow:${scope.workflowId}`)) {
      client.socket.send(json);
    }
  }
}

/**
 * Chunk coalescer — batches text segments with 1ms debounce, flushes immediately on tool segments.
 * Reduces WS frame count ~5x for streaming text.
 */
export function createChunkCoalescer(scope?: BroadcastScope) {
  const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

  function flush(filterKey: string): void {
    const entry = pending.get(filterKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(filterKey);
    const json = JSON.stringify({
      event: 'acp:segment',
      data: { key: filterKey, type: 'text', content: entry.text },
      timestamp: new Date().toISOString(),
    });
    broadcastRaw(json, scope);
  }

  return {
    /** Queue a text chunk — will be coalesced and sent after 1ms of quiet */
    text(filterKey: string, text: string): void {
      const entry = pending.get(filterKey);
      if (entry) {
        entry.text += text;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => flush(filterKey), 1);
      } else {
        pending.set(filterKey, {
          text,
          timer: setTimeout(() => flush(filterKey), 1),
        });
      }
    },

    /** Flush pending text immediately, then send the tool segment */
    tool(filterKey: string, toolCallId: string): void {
      flush(filterKey);
      const json = JSON.stringify({
        event: 'acp:segment',
        data: { key: filterKey, type: 'tool', toolCallId },
        timestamp: new Date().toISOString(),
      });
      broadcastRaw(json, scope);
    },

    /** Flush any pending text for this key (call on turn end) */
    flush(filterKey: string): void {
      flush(filterKey);
    },
  };
}

export function getConnectedClients(): number {
  return clients.size;
}
