/**
 * ACP Client — manages an ACP-compatible CLI child process.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 * Composes ProcessHandle, JsonRpcTransport, McpReadinessTracker, and TypedEmitter
 * rather than inlining all logic directly.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TypedEmitter, type AcpClientEvents } from './events.js';
import { ProcessHandle } from './transport/process.js';
import type { JsonRpcTransport } from './transport/json-rpc.js';
import { McpReadinessTracker } from './mcp-readiness.js';
import type { AcpProvider } from './provider/types.js';

const execAsync = promisify(exec);

export interface AcpSessionInfo {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: unknown[] };
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface PromptResponse {
  stopReason?: string;
  [key: string]: unknown;
}

export class AcpClient extends TypedEmitter<AcpClientEvents> {
  private processHandle = new ProcessHandle();
  private transport: JsonRpcTransport | null = null;
  private mcpTracker: McpReadinessTracker | null = null;

  private sessionId: string | null = null;
  private destroyed = false;
  private _cancelRequested = false;
  private _modelName: string | null = null;

  private provider: AcpProvider;
  private workingDir: string;

  constructor(config: { provider: AcpProvider; workingDir: string }) {
    super();
    this.provider = config.provider;
    this.workingDir = config.workingDir;
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get pid(): number | null {
    return this.processHandle.pid;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get cancelRequested(): boolean {
    return this._cancelRequested;
  }

  get lastStderr(): string {
    return this.processHandle.stderrBuffer;
  }

  get modelName(): string | null {
    return this._modelName;
  }

  resetCancel(): void {
    this._cancelRequested = false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawn the provider's CLI in ACP mode and send the initialize handshake.
   */
  async start(options?: { agent?: string; model?: string; env?: Record<string, string> }): Promise<void> {
    const command = this.provider.getCommand();
    const args = this.provider.getSpawnArgs({ agent: options?.agent, model: options?.model });
    const env = { ...this.provider.getSpawnEnv(), ...options?.env };

    this.transport = this.processHandle.spawn({ command, args, cwd: this.workingDir, env });
    console.log(`[acp] Process spawned (pid: ${this.processHandle.pid})`);

    // Wire transport events
    this.transport.on('notification', ({ method, params }) => {
      this.handleNotification(method, params ?? {});
    });

    this.transport.on('request', ({ id, method, params }) => {
      this.handleRequest(id, method, params ?? {});
    });

    // Wire process events → emit on self
    this.processHandle.onProcessEvent({
      stderr: (text) => this.emit('stderr', text),
      close: (info) => {
        this.destroyed = true;
        this.emit('close', info);
      },
      error: (err) => this.emit('error', err),
    });

    // Initialize handshake
    await this.transport.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'autome', version: '0.1.0' },
      clientCapabilities: {
        terminal: true,
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  }

  /**
   * Create a new ACP session.
   */
  async newSession(mcpServers: McpServerConfig[] = [], systemPrompt?: string, meta?: Record<string, unknown>): Promise<AcpSessionInfo> {
    this.resetMcpTracker(mcpServers.length);

    const params: Record<string, unknown> = { cwd: this.workingDir, mcpServers };
    if (systemPrompt) params.systemPrompt = systemPrompt;
    if (meta) params._meta = meta;

    const timeoutMs = this.provider.sessionCreateTimeoutMs ?? 30000;
    const result = await this.transport!.request<AcpSessionInfo>('session/new', params, timeoutMs);
    this.sessionId = result.sessionId;
    this.extractModelFromConfig(result);
    console.log(`[acp] Session created: ${this.sessionId}`);

    // The prompt() method awaits mcpTracker.ready before sending the first message.
    return result;
  }

  /**
   * Load an existing ACP session by ID.
   */
  async loadSession(sessionId: string, mcpServers: McpServerConfig[] = []): Promise<AcpSessionInfo> {
    this.resetMcpTracker(mcpServers.length);

    const timeoutMs = this.provider.sessionCreateTimeoutMs ?? 30000;
    const result = await this.transport!.request<AcpSessionInfo>(
      'session/load',
      { sessionId, cwd: this.workingDir, mcpServers },
      timeoutMs,
    );
    this.sessionId = sessionId;
    this.extractModelFromConfig(result);
    console.log(`[acp] Session loaded: ${this.sessionId}`);

    return result;
  }

  /**
   * Send a prompt to the active session.
   * Waits for MCP readiness, retries on "not idle" with backoff.
   */
  async prompt(text: string): Promise<PromptResponse | undefined> {
    if (!this.sessionId) throw new Error('No active session');

    // Wait for MCP servers to settle
    if (this.mcpTracker && !this.mcpTracker.isReady) {
      await this.mcpTracker.ready;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.transport!.request<PromptResponse>('session/prompt', {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text }],
        });
        // prompt response contains stopReason — this IS the turn_end signal
        if (result?.stopReason) {
          this.emit('turn_end', result);
        }
        return result;
      } catch (err: unknown) {
        if (err instanceof Error && err.message?.includes('not idle') && attempt < maxAttempts) {
          const delay = attempt * 2000;
          console.log(`[acp] Prompt retry ${attempt}/${maxAttempts} in ${delay}ms: ${err.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Cancel the current turn (notification — no response expected).
   * Session stays alive for resuming.
   */
  cancel(): void {
    this._cancelRequested = true;
    if (!this.sessionId || !this.transport) return;
    this.transport.notify('session/cancel', { sessionId: this.sessionId });
  }

  /**
   * Respond to a permission request from the agent CLI.
   */
  respondPermission(requestId: string, optionId: string): void {
    this.transport?.respond(requestId, { outcome: { outcome: 'selected', optionId } });
  }

  /**
   * Kill the child process and its descendant tree.
   * Normal: cancel → SIGTERM (500ms) → SIGKILL (2.5s)
   * Immediate: SIGKILL now (for server shutdown)
   */
  destroy(options?: { immediate?: boolean }): void {
    this.destroyed = true;
    this._cancelRequested = true;

    this.mcpTracker?.dispose();
    this.mcpTracker = null;

    // Send cancel notification before killing the process
    if (!options?.immediate) {
      try { this.cancel(); } catch { /* session may not exist yet */ }
    }

    this.processHandle.destroy(options);
  }

  // ---------------------------------------------------------------------------
  // Private: MCP tracker setup
  // ---------------------------------------------------------------------------

  private resetMcpTracker(serverCount: number): void {
    // Dispose previous tracker if any
    this.mcpTracker?.dispose();

    this.mcpTracker = new McpReadinessTracker({
      serverCount,
      trackVendorEvents: this.provider.tracksMcpReadiness,
      fallbackDelayMs: this.provider.mcpReadinessDelayMs ?? 3000,
      onReady: (servers) => this.emit('mcp_all_ready', { servers }),
      onServerReady: (serverName, total, expected) =>
        this.emit('mcp_server_ready', { serverName, total, expected }),
      onServerFailed: (serverName, error, expected) =>
        this.emit('mcp_server_failed', { serverName, error, expected }),
    });
  }

  // ---------------------------------------------------------------------------
  // Private: notification handling
  // ---------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/update') {
      const notification = params?.notification;
      if (notification === 'config_option_update') {
        this.extractModelFromConfig(params);
        return;
      }

      const update = params?.update as Record<string, unknown> | undefined;
      const kind = update?.sessionUpdate;

      if (kind === 'agent_message_chunk') {
        this.emit('agent_message_chunk', update?.content as AcpClientEvents['agent_message_chunk']);
      } else if (kind === 'tool_call') {
        this.emit('tool_call', update as AcpClientEvents['tool_call']);
      } else if (kind === 'tool_call_update') {
        this.emit('tool_call_update', update as AcpClientEvents['tool_call_update']);
      } else if (kind === 'turn_end') {
        this.emit('turn_end', update as AcpClientEvents['turn_end']);
      }
      return;
    }

    // Delegate vendor-specific notifications to the provider
    const vendorResult = this.provider.handleVendorNotification(method, params);
    if (!vendorResult) return;

    if (vendorResult.event === 'vendor:mcp_server_initialized') {
      const serverName = (params?.serverName as string | undefined) ?? 'unknown';
      this.mcpTracker?.onServerInitialized(serverName);
    } else if (vendorResult.event === 'vendor:mcp_server_init_failure') {
      const serverName = (params?.serverName as string | undefined) ?? 'unknown';
      const error = (params?.error as string | undefined) ?? 'Unknown error';
      this.mcpTracker?.onServerInitFailed(serverName, error);
    } else if (vendorResult.event === 'vendor:commands_available') {
      const serverList = params?.mcpServers;
      if (Array.isArray(serverList) && serverList.length > 0) {
        const count = (serverList as Array<{ status?: string }>).filter((s) => s.status !== 'disabled').length;
        this.mcpTracker?.setExpectedCount(count);
      }
    } else if (vendorResult.event === 'vendor:metadata') {
      this.emit('metadata', params as AcpClientEvents['metadata']);
    } else if (vendorResult.event === 'vendor:compaction') {
      this.emit('compaction', params as AcpClientEvents['compaction']);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: request handling
  // ---------------------------------------------------------------------------

  private handleRequest(id: string, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      // Always auto-approve — agents run fully trusted, no human approval needed
      const options = (params?.options as Array<{ kind: string; optionId: string }> | undefined) ?? [];
      const allowOption =
        options.find((o) => o.kind === 'allow_always') ||
        options.find((o) => o.kind === 'allow_session') ||
        options.find((o) => o.kind === 'allow_once') ||
        options[0];
      if (allowOption) {
        this.respondPermission(id, allowOption.optionId);
      } else {
        // No options provided — respond with a generic approval to unblock the agent
        this.transport?.respond(id, { outcome: { outcome: 'approved' } });
      }
      this.emit('request_permission', { requestId: id, ...params } as AcpClientEvents['request_permission']);
    } else if (method === 'fs/readTextFile') {
      const filePath = params?.path as string;
      readFile(filePath, 'utf-8')
        .then((content) => this.transport?.respond(id, { content }))
        .catch(() => this.transport?.respond(id, null, { code: -32000, message: 'File not found' }));
    } else if (method === 'fs/writeTextFile') {
      const filePath = params?.path as string;
      const fileContent = params?.content as string;
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      (dir ? mkdir(dir, { recursive: true }) : Promise.resolve())
        .then(() => writeFile(filePath, fileContent, 'utf-8'))
        .then(() => this.transport?.respond(id, {}))
        .catch((err: Error) => this.transport?.respond(id, null, { code: -32000, message: err.message }));
    } else if (method === 'terminal/create') {
      const terminalId = `term-${Date.now()}`;
      const termCmd = params?.command as string;
      const termArgs = params?.args as string[] | undefined;
      const command = termCmd + (termArgs?.length ? ' ' + termArgs.join(' ') : '');
      const termCwd = params?.cwd as string | undefined;
      execAsync(command, { cwd: termCwd || this.workingDir, timeout: 60000 })
        .then(({ stdout }) => this.emit('terminal_output', { terminalId, output: stdout }))
        .catch((err: Error) => this.emit('terminal_output', { terminalId, output: err.message, error: true }));
      this.transport?.respond(id, { terminalId });
    } else if (method === 'terminal/output') {
      this.transport?.respond(id, { output: '', truncated: false });
    } else if (method === 'terminal/waitForExit') {
      this.transport?.respond(id, { exitCode: 0 });
    } else if (method === 'terminal/kill' || method === 'terminal/release') {
      this.transport?.respond(id, {});
    } else {
      this.transport?.respond(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: model extraction
  // ---------------------------------------------------------------------------

  private extractModelFromConfig(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const configOptions = (result as Record<string, unknown>).configOptions;
    if (!Array.isArray(configOptions)) return;

    const modelOption = configOptions.find(
      (opt: unknown) => opt && typeof opt === 'object' && (opt as Record<string, unknown>).category === 'model',
    );
    if (!modelOption) return;

    const raw = modelOption as Record<string, unknown>;
    const currentValue = typeof raw.currentValue === 'string' ? raw.currentValue : (typeof raw.value === 'string' ? raw.value : null);
    if (!currentValue) return;

    // Look up the selected option to get a display name
    let displayName = currentValue;
    const options = raw.options;
    if (Array.isArray(options)) {
      const selected = options.find(
        (o: unknown) => o && typeof o === 'object' && (o as Record<string, unknown>).value === currentValue,
      ) as Record<string, unknown> | undefined;
      if (selected) {
        // Try to extract model name from description (e.g. "Opus 4.6 with 1M context · Most capable...")
        const desc = typeof selected.description === 'string' ? selected.description : '';
        const modelMatch = desc.match(/^([\w.]+ [\d.]+)/);
        if (modelMatch) {
          displayName = modelMatch[1]; // e.g. "Opus 4.6", "Sonnet 4.6", "Haiku 4.5"
        } else if (typeof selected.name === 'string') {
          // Strip parenthetical suffixes like "(recommended)"
          displayName = selected.name.replace(/\s*\(.*?\)\s*$/, '').trim();
        }
      }
    }

    this._modelName = displayName;
    console.log(`[acp] Model detected: ${this._modelName}`);
    this.emit('model_info', { model: this._modelName });
  }
}

