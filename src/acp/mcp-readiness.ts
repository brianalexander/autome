/**
 * Tracks MCP server initialization readiness.
 *
 * Two strategies:
 * 1. Vendor tracking: Provider sends per-server notifications → we count completions
 * 2. Fallback delay: Wait a fixed period after session creation
 *
 * Both have a hard timeout to prevent indefinite blocking.
 */
export class McpReadinessTracker {
  private _ready = false;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;
  private readyServers = new Set<string>();
  private failedServers = new Map<string, string>();
  private expectedCount: number | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  private onReady?: (servers: string[]) => void;
  private onServerReady?: (serverName: string, total: number, expected: number | null) => void;
  private onServerFailed?: (serverName: string, error: string, expected: number | null) => void;

  static readonly HARD_TIMEOUT_MS = 30000;

  constructor(private opts: {
    serverCount: number;
    trackVendorEvents: boolean;
    fallbackDelayMs: number;
    onReady?: (servers: string[]) => void;
    onServerReady?: (serverName: string, total: number, expected: number | null) => void;
    onServerFailed?: (serverName: string, error: string, expected: number | null) => void;
  }) {
    this.onReady = opts.onReady;
    this.onServerReady = opts.onServerReady;
    this.onServerFailed = opts.onServerFailed;

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    if (opts.serverCount === 0) {
      this.resolve();
    } else if (!opts.trackVendorEvents) {
      // No vendor notifications — use a fixed delay
      this.fallbackTimer = setTimeout(() => {
        if (!this._ready) this.resolve();
      }, opts.fallbackDelayMs);
    } else {
      // Vendor tracking mode — hard timeout as safety net
      this.fallbackTimer = setTimeout(() => {
        if (!this._ready) {
          console.warn(`[mcp-readiness] Timeout after ${McpReadinessTracker.HARD_TIMEOUT_MS}ms — ${this.readyServers.size} servers ready`);
          this.resolve();
        }
      }, McpReadinessTracker.HARD_TIMEOUT_MS);
    }
  }

  /** Promise that resolves when MCP servers are ready */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get isReady(): boolean {
    return this._ready;
  }

  /** Called when a vendor notification reports a server initialized */
  onServerInitialized(serverName: string): void {
    if (this._ready) return;
    const isNew = !this.readyServers.has(serverName);
    this.readyServers.add(serverName);
    if (isNew) {
      this.onServerReady?.(serverName, this.readyServers.size, this.expectedCount);
    }
    this.checkComplete();
  }

  /** Called when a vendor notification reports a server init failure */
  onServerInitFailed(serverName: string, error: string): void {
    if (this._ready) return;
    this.failedServers.set(serverName, error);
    this.onServerFailed?.(serverName, error, this.expectedCount);
    this.checkComplete();
  }

  /** Called when the provider reports the full list of expected MCP servers */
  setExpectedCount(count: number): void {
    this.expectedCount = count;
    this.checkComplete();
  }

  /** Dispose timers */
  dispose(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    // If not yet resolved, resolve now to unblock any waiters
    if (!this._ready) this.resolve();
  }

  private checkComplete(): void {
    if (this._ready || this.expectedCount === null) return;
    const reported = new Set([...this.readyServers, ...this.failedServers.keys()]);
    if (reported.size >= this.expectedCount) {
      this.resolve();
    }
  }

  private resolve(): void {
    if (this._ready) return;
    this._ready = true;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.readyResolve?.();
    this.onReady?.([...this.readyServers]);
  }
}
