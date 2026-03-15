import type { Readable, Writable } from 'stream';
import { TypedEmitter, type TransportEvents } from '../events.js';

/** JSON-RPC 2.0 message types */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * JSON-RPC 2.0 transport over newline-delimited streams.
 *
 * Handles:
 * - Line buffering and JSON parsing
 * - Request/response correlation with timeouts
 * - Notification and request dispatch via events
 */
export class JsonRpcTransport extends TypedEmitter<TransportEvents> {
  private input: Readable;
  private output: Writable;
  private buffer = '';
  private nextId = 1;
  private pendingRequests = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private closed = false;

  constructor(input: Readable, output: Writable) {
    super();
    this.input = input;
    this.output = output;

    this.input.on('data', (chunk: Buffer) => this.onData(chunk));
    this.input.on('end', () => this.handleClose());
  }

  /** Send a JSON-RPC request and wait for a response */
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Transport closed'));
      const id = String(this.nextId++);

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
          }
        }, timeoutMs);
      }

      this.pendingRequests.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v as T); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        timer,
      });

      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a JSON-RPC notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Send a JSON-RPC response to a request from the agent */
  respond(id: string, result: unknown, error?: { code: number; message: string }): void {
    if (this.closed) return;
    const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) msg.error = error;
    else msg.result = result ?? null;
    this.write(msg);
  }

  /** Close the transport, rejecting all pending requests */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error('Transport closed'));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // --- Private ---

  private write(msg: Record<string, unknown>): void {
    if (!this.output.writable) return;
    this.output.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let start = 0;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n', start)) !== -1) {
      const line = this.buffer.slice(start, newlineIdx).trim();
      start = newlineIdx + 1;
      if (!line) continue;
      this.processLine(line);
    }
    if (start > 0) this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
  }

  private processLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip unparseable lines
    }

    // Filter empty-line parse errors from kiro-cli
    if ('error' in msg && (msg as JsonRpcResponse).error?.code === -32700 && (msg as JsonRpcResponse).error?.data === '') {
      return;
    }

    // Response to a pending request
    if ('id' in msg && msg.id) {
      if (this.pendingRequests.has(msg.id as string)) {
        const pending = this.pendingRequests.get(msg.id as string)!;
        this.pendingRequests.delete(msg.id as string);
        const resp = msg as JsonRpcResponse;
        if ('error' in resp && resp.error) {
          pending.reject(new Error(`${resp.error.message} (code: ${resp.error.code})`));
        } else {
          pending.resolve(resp.result);
        }
        return;
      }
      // Request from agent (has both method and id)
      if ('method' in msg) {
        this.emit('request', { id: msg.id as string, method: (msg as JsonRpcRequest).method, params: (msg as JsonRpcRequest).params });
        return;
      }
    }

    // Notification (method but no id)
    if ('method' in msg) {
      this.emit('notification', { method: (msg as JsonRpcNotification).method, params: (msg as JsonRpcNotification).params });
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error('Transport stream ended'));
    this.emit('close', undefined);
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}
