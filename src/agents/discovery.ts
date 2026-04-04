import { createProvider } from '../acp/provider/registry.js';
import type { AcpProvider, AgentDiscoveryOptions } from '../acp/provider/types.js';
import type { DiscoveredAgent } from '../types/instance.js';
import { config, DEFAULT_ACP_PROVIDER } from '../config.js';

// Re-export types for existing consumers
export type { DiscoveredAgent, AgentDiscoveryOptions };
export type { AgentSpec } from '../types/instance.js';

let _defaultProvider: AcpProvider | null = null;

/** Override the provider used by discovery functions (e.g., for testing or server init). */
export function setDefaultProvider(provider: AcpProvider): void {
  _defaultProvider = provider;
}

/** Reset the default provider (e.g., in tests). */
export function resetDefaultProvider(): void {
  _defaultProvider = null;
}

/** Discover all available agents from the active provider. */
export async function discoverAgents(workingDirOrOpts?: string | AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
  const provider = _defaultProvider || createProvider(config.acpProvider ?? DEFAULT_ACP_PROVIDER);
  const opts: AgentDiscoveryOptions =
    typeof workingDirOrOpts === 'string' ? { workingDir: workingDirOrOpts } : workingDirOrOpts || {};
  return provider.discoverAgents(opts);
}

/** Get a specific agent spec by name from the active provider. */
export async function getAgentSpec(
  name: string,
  workingDirOrOpts?: string | AgentDiscoveryOptions,
): Promise<DiscoveredAgent | null> {
  const provider = _defaultProvider || createProvider(config.acpProvider ?? DEFAULT_ACP_PROVIDER);
  const opts: AgentDiscoveryOptions =
    typeof workingDirOrOpts === 'string' ? { workingDir: workingDirOrOpts } : workingDirOrOpts || {};
  return provider.getAgentSpec(name, opts);
}
