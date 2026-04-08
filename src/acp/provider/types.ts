import type { DiscoveredAgent } from '../../types/instance.js';

/** Provider-neutral agent definition — the common schema all providers convert to/from */
export interface CanonicalAgentSpec {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Record<string, {
    command: string;
    args: string[];
    env_keys?: string[];
  }>;
  toolsSettings?: {
    subagent?: {
      availableAgents?: string[];
    };
  };
}

export interface AgentDiscoveryOptions {
  workingDir?: string;
  workflowId?: string;
  bundlesDir?: string;
}

export type VendorNotificationResult =
  | { type: 'mcp_server_initialized'; serverName: string }
  | { type: 'mcp_server_failed'; serverName: string; error: string }
  | { type: 'mcp_server_list'; servers: Array<{ name: string; status?: string }> }
  | { type: 'metadata'; data: Record<string, unknown> }
  | { type: 'compaction'; data: Record<string, unknown> }
  | { type: 'ignore' }
  | null;

/**
 * ACP Provider — abstracts vendor-specific details of an ACP-compatible CLI.
 *
 * The ACP protocol itself (JSON-RPC 2.0 over stdio) is standardized.
 * Providers handle: CLI invocation, agent discovery, vendor notifications.
 */
export interface AcpProvider {
  readonly name: string;
  readonly displayName: string;

  // -- Process spawning --
  getCommand(): string;
  getSpawnArgs(options: { agent?: string; model?: string }): string[];
  getSpawnEnv(): Record<string, string>;

  // -- Agent discovery --
  discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]>;
  getAgentSpec(name: string, opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent | null>;
  getLocalAgentDir(workingDir: string): string;
  getGlobalAgentDir(): string;

  // -- Vendor extensions --
  handleVendorNotification(method: string, params: Record<string, unknown>): VendorNotificationResult | null;

  // -- Capabilities --
  readonly supportsSessionResume: boolean;
  readonly tracksMcpReadiness: boolean;
  readonly mcpReadinessDelayMs?: number;
  readonly sessionCreateTimeoutMs?: number;

  // -- Optional hooks --
  cleanupSessionLocks?(): Promise<void>;
  prepareWorkingDir?(workDir: string): Promise<void>;
  writeAgentFile?(dir: string, name: string, canonical: CanonicalAgentSpec, prompt: string): Promise<string>;

  /** Filter incoming JSON-RPC messages. Return false to drop the message. */
  filterIncomingMessage?(msg: unknown): boolean;

  /** Check if an error from prompt() should be retried */
  isRetryableError?(err: Error): boolean;

  /** Extract model name from session creation result */
  extractModelName?(sessionResult: unknown): string | null;

  /** Check if the provider CLI is installed and accessible */
  checkInstalled?(): Promise<{ ok: boolean; hint?: string }>;

  /** Protocol version for the initialize handshake */
  getProtocolVersion?(): number;

  /** Client capabilities for the initialize handshake */
  getClientCapabilities?(): Record<string, unknown>;
}

// Re-export for convenience
export type { DiscoveredAgent };
