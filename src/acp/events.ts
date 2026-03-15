import { EventEmitter } from 'events';

/**
 * Type-safe EventEmitter. Enforces event names and payload types at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEmitter<Events extends Record<string, any>> {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  on<K extends keyof Events & string>(event: K, listener: (data: Events[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (data: Events[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (data: Events[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof Events & string>(event: K, data: Events[K]): boolean {
    return this.emitter.emit(event, data);
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}

/** Events emitted by the JSON-RPC transport layer */
export interface TransportEvents {
  /** A JSON-RPC notification received from the agent */
  notification: { method: string; params?: Record<string, unknown> };
  /** A JSON-RPC request received from the agent (needs a response) */
  request: { id: string; method: string; params?: Record<string, unknown> };
  /** Transport-level error (parse failure, etc.) */
  error: Error;
  /** Transport closed */
  close: void;
}

/** Events emitted by the ACP client */
export interface AcpClientEvents {
  // --- Standard ACP events ---
  agent_message_chunk: { type: string; text?: string };
  tool_call: { toolCallId: string; title?: string; kind?: string; status: string; rawInput?: string; [key: string]: unknown };
  tool_call_update: { toolCallId: string; status: string; rawOutput?: string; kind?: string; [key: string]: unknown };
  turn_end: { stopReason?: string; endReason?: string; usage?: Record<string, unknown>; contextUsagePercentage?: number; [key: string]: unknown };
  request_permission: { requestId: string; sessionId?: string; toolCall?: unknown; options?: unknown[] };

  // --- MCP readiness events ---
  mcp_server_ready: { serverName: string; total: number; expected: number | null };
  mcp_server_failed: { serverName: string; error: string; expected: number | null };
  mcp_all_ready: { servers: string[] };

  // --- Metadata events ---
  metadata: Record<string, unknown>;
  compaction: Record<string, unknown>;
  model_info: { model: string };
  terminal_output: { terminalId: string; output: string; error?: boolean };

  // --- Process events ---
  stderr: string;
  error: Error;
  close: { code: number | null; signal: string | null; stderr: string };
}
