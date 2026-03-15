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
}

export interface AgentDiscoveryOptions {
  workingDir?: string;
  workflowId?: string;
  bundlesDir?: string;
}

export interface VendorNotificationResult {
  event: string;
  data: Record<string, unknown>;
}

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
}

// Re-export for convenience
export type { DiscoveredAgent };
