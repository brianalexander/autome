import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { BaseProvider } from './base.js';
import type { CanonicalAgentSpec, VendorNotificationResult, DiscoveredAgent } from './types.js';

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

export class GenericProvider extends BaseProvider {
  readonly name: string;
  readonly displayName: string;
  readonly supportsSessionResume: boolean;
  readonly tracksMcpReadiness: boolean;
  readonly mcpReadinessDelayMs: number;
  readonly sessionCreateTimeoutMs?: number;

  private config: GenericProviderConfig;

  protected get agentFileExtensions(): string[] {
    return this.config.agentFileExtensions || ['.json'];
  }

  constructor(config: GenericProviderConfig) {
    super();
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

  protected parseAgentFile(content: string, fileName: string): DiscoveredAgent | null {
    const raw = JSON.parse(content);
    const name = raw.name || fileName.replace(/\.[^.]+$/, '');
    const spec = { name, ...raw };
    return { name, spec, source: 'local', path: '' };
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
