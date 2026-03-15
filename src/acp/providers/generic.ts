import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { AcpProvider, AgentDiscoveryOptions, VendorNotificationResult, CanonicalAgentSpec } from '../provider/types.js';
import type { DiscoveredAgent } from '../../types/instance.js';

/**
 * Configuration schema for a generic ACP provider.
 * Users drop a JSON file in ~/.autome/providers/ or ./providers/ to register.
 */
export interface GenericProviderConfig {
  /** Unique identifier (e.g., 'claude-code', 'gemini-cli') */
  name: string;
  /** Human-readable label for UI */
  displayName: string;

  /** CLI binary name or path. Supports $ENV_VAR substitution. */
  command: string;
  /** CLI arguments for ACP mode. Supports {{agent}} and {{model}} placeholders. */
  args: string[];
  /** Extra environment variables to set when spawning */
  env?: Record<string, string>;

  /** Agent config directory paths (relative to working dir for local, absolute for global) */
  agentDirs?: {
    /** Relative path from working dir (e.g., '.kiro/agents', '.opencode/agents', '.claude/agents') */
    local?: string;
    /** Absolute path or ~ path (e.g., '~/.kiro/agents', '~/.config/opencode/agents') */
    global?: string;
  };

  /** Agent config file extensions to scan (default: ['.json']) */
  agentFileExtensions?: string[];

  /** Whether this provider supports session/load for resuming sessions */
  supportsSessionResume?: boolean;

  /** Milliseconds to wait for MCP servers when no readiness tracking is available. Default: 3000 */
  mcpReadinessDelayMs?: number;

  /** Timeout in ms for session creation. Default: 30000. Claude needs 60000. */
  sessionCreateTimeoutMs?: number;

  /**
   * Vendor notification prefix to recognize (e.g., '_kiro.dev/', '_claude.').
   * Notifications matching this prefix get mapped to vendor:* events.
   * If not set, all non-standard notifications are ignored.
   */
  vendorNotificationPrefix?: string;

  /**
   * Map of vendor notification method suffixes to event names.
   * e.g., { "mcp/server_initialized": "mcp_server_initialized" }
   * The full method is vendorNotificationPrefix + suffix.
   * Events are emitted as "vendor:<eventName>".
   */
  vendorNotificationMap?: Record<string, string>;
}

export class GenericAcpProvider implements AcpProvider {
  readonly name: string;
  readonly displayName: string;
  readonly supportsSessionResume: boolean;
  readonly tracksMcpReadiness: boolean;
  readonly mcpReadinessDelayMs: number;
  readonly sessionCreateTimeoutMs?: number;

  private config: GenericProviderConfig;

  constructor(config: GenericProviderConfig) {
    this.config = config;
    this.name = config.name;
    this.displayName = config.displayName;
    this.supportsSessionResume = config.supportsSessionResume ?? false;
    // tracksMcpReadiness is true if the vendor notification map contains an entry
    // that maps to 'mcp_server_initialized', meaning the provider sends per-server init notifications
    this.tracksMcpReadiness = Object.values(config.vendorNotificationMap || {}).includes('mcp_server_initialized');
    this.mcpReadinessDelayMs = config.mcpReadinessDelayMs ?? 3000;
    this.sessionCreateTimeoutMs = config.sessionCreateTimeoutMs;
  }

  getCommand(): string {
    // Support $ENV_VAR substitution in command
    return this.config.command.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
      return process.env[name] || '';
    });
  }

  getSpawnArgs(options: { agent?: string; model?: string }): string[] {
    return this.config.args
      .map((arg) => {
        return arg.replace('{{agent}}', options.agent || '').replace('{{model}}', options.model || '');
      })
      .filter((arg) => arg !== ''); // Remove empty args from unresolved placeholders
  }

  getSpawnEnv(): Record<string, string> {
    return { ...this.config.env };
  }

  getLocalAgentDir(workingDir: string): string {
    const localPath = this.config.agentDirs?.local || '.agents';
    return join(workingDir, localPath);
  }

  getGlobalAgentDir(): string {
    const globalPath = this.config.agentDirs?.global || join('~', '.autome', 'agents');
    // Expand ~ to home directory
    return globalPath.startsWith('~') ? join(homedir(), globalPath.slice(1)) : globalPath;
  }

  handleVendorNotification(method: string, params: Record<string, unknown>): VendorNotificationResult | null {
    const prefix = this.config.vendorNotificationPrefix;
    if (!prefix || !method.startsWith(prefix)) return null;

    const suffix = method.slice(prefix.length);
    const map = this.config.vendorNotificationMap || {};

    // Check explicit mapping first
    if (map[suffix]) {
      return { event: `vendor:${map[suffix]}`, data: params };
    }

    // If we have a prefix match but no explicit mapping, emit a generic event
    // using the suffix as the event name (replacing / with _)
    return { event: `vendor:${suffix.replace(/\//g, '_')}`, data: params };
  }

  async writeAgentFile(dir: string, name: string, canonical: CanonicalAgentSpec, prompt: string): Promise<string> {
    const ext = this.config.agentFileExtensions?.[0] || '.json';
    const fileName = `${name}${ext}`;
    const filePath = join(dir, fileName);

    const config: Record<string, unknown> = {
      name: canonical.name,
      description: canonical.description,
      prompt,
      tools: canonical.tools || [],
    };
    if (canonical.model) config.model = canonical.model;

    await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return fileName;
  }

  async discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const seen = new Set<string>();
    const extensions = this.config.agentFileExtensions || ['.json'];

    // Workflow-scoped agents (from bundles)
    if (opts?.workflowId) {
      const bundlesBase = opts.bundlesDir || join(process.cwd(), 'data', 'bundles');
      const bundleAgentDir = join(bundlesBase, opts.workflowId, 'agents');
      for (const agent of await this.scanAgentDir(bundleAgentDir, 'local', extensions)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Local agents
    const localDir = this.getLocalAgentDir(opts?.workingDir || process.cwd());
    for (const agent of await this.scanAgentDir(localDir, 'local', extensions)) {
      if (!seen.has(agent.name)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Global agents
    const globalDir = this.getGlobalAgentDir();
    for (const agent of await this.scanAgentDir(globalDir, 'global', extensions)) {
      if (!seen.has(agent.name)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Fallback: canonical agent definitions (agents/ directory)
    // Used if no provider-specific config exists yet (e.g., before generate has run)
    const canonicalDir = join(opts?.workingDir || process.cwd(), 'agents');
    try {
      const entries = await readdir(canonicalDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const specPath = join(canonicalDir, entry.name, 'agent.json');
        try {
          const content = await readFile(specPath, 'utf-8');
          const raw = JSON.parse(content);
          const promptPath = join(canonicalDir, entry.name, 'prompt.md');
          let prompt = '';
          try {
            if (existsSync(promptPath)) prompt = await readFile(promptPath, 'utf-8');
          } catch {}
          const spec = { ...raw, prompt: prompt || raw.prompt || '' };
          agents.push({ name: raw.name || entry.name, spec, source: 'local', path: specPath });
          seen.add(raw.name || entry.name);
        } catch {}
      }
    } catch {}

    return agents;
  }

  async getAgentSpec(name: string, opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent | null> {
    const agents = await this.discoverAgents(opts);
    return agents.find((a) => a.name === name) || null;
  }

  private async scanAgentDir(
    dir: string,
    source: 'local' | 'global',
    extensions: string[],
  ): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!extensions.some((ext) => file.endsWith(ext))) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const raw = JSON.parse(content);
          const name = raw.name || file.replace(/\.[^.]+$/, '');
          const spec = { name, ...raw };
          agents.push({ name, spec, source, path: filePath });
        } catch (err) {
          console.warn(`Failed to parse agent spec ${filePath}:`, err);
        }
      }
    } catch {
      /* directory doesn't exist */
    }
    return agents;
  }
}

/**
 * Load a GenericProviderConfig from a JSON file.
 */
export async function loadProviderConfig(filePath: string): Promise<GenericProviderConfig> {
  const content = await readFile(filePath, 'utf-8');
  const config = JSON.parse(content) as GenericProviderConfig;
  if (!config.name || !config.displayName || !config.command || !Array.isArray(config.args)) {
    throw new Error(`Invalid provider config at ${filePath}: must have name, displayName, command, and args`);
  }
  return config;
}
