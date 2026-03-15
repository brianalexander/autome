import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { AcpProvider, AgentDiscoveryOptions, VendorNotificationResult, DiscoveredAgent } from './types.js';

/**
 * Base class for ACP providers.
 * Provides shared agent discovery logic — subclasses only supply:
 * - Directory paths (getLocalAgentDir, getGlobalAgentDir)
 * - File parsing (parseAgentFile)
 * - Vendor notification handling
 * - Spawn configuration
 */
export abstract class BaseProvider implements AcpProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly supportsSessionResume: boolean;
  abstract readonly tracksMcpReadiness: boolean;
  readonly mcpReadinessDelayMs?: number;
  readonly sessionCreateTimeoutMs?: number;

  /** File extensions this provider scans for agent definitions */
  protected abstract readonly agentFileExtensions: string[];

  abstract getCommand(): string;
  abstract getSpawnArgs(options: { agent?: string; model?: string }): string[];
  abstract getSpawnEnv(): Record<string, string>;
  abstract getLocalAgentDir(workingDir: string): string;
  abstract getGlobalAgentDir(): string;
  abstract handleVendorNotification(method: string, params: Record<string, unknown>): VendorNotificationResult | null;

  /**
   * Parse a single agent file into a DiscoveredAgent.
   * Subclasses override this for format-specific parsing (JSON, JSONC, Markdown frontmatter, etc.)
   * Return null to skip the file.
   */
  protected abstract parseAgentFile(content: string, fileName: string): DiscoveredAgent | null;

  // -- Shared discovery logic --

  async discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const seen = new Set<string>();

    const addAgents = (newAgents: DiscoveredAgent[]) => {
      for (const agent of newAgents) {
        if (!seen.has(agent.name)) {
          agents.push(agent);
          seen.add(agent.name);
        }
      }
    };

    // 1. Workflow-scoped agents (highest priority — from imported bundles)
    if (opts?.workflowId) {
      const bundlesBase = opts.bundlesDir || join(process.cwd(), 'data', 'bundles');
      const bundleAgentDir = join(bundlesBase, opts.workflowId, 'agents');
      addAgents(await this.scanAgentDir(bundleAgentDir, 'local'));
    }

    // 2. Provider-specific local agents
    const localDir = this.getLocalAgentDir(opts?.workingDir || process.cwd());
    addAgents(await this.scanAgentDir(localDir, 'local'));

    // 3. Canonical agents (agents/<name>/agent.json + prompt.md)
    addAgents(await this.scanCanonicalAgents(opts?.workingDir || process.cwd()));

    // 4. Provider-specific global agents
    const globalDir = this.getGlobalAgentDir();
    addAgents(await this.scanAgentDir(globalDir, 'global'));

    return agents;
  }

  async getAgentSpec(name: string, opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent | null> {
    const agents = await this.discoverAgents(opts);
    return agents.find((a) => a.name === name) || null;
  }

  // -- Shared scanning utilities --

  protected async scanAgentDir(dir: string, source: 'local' | 'global'): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!this.agentFileExtensions.some((ext) => file.endsWith(ext))) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const agent = this.parseAgentFile(content, file);
          if (agent) {
            agent.source = source;
            agent.path = filePath;
            agents.push(agent);
          }
        } catch (err) {
          console.warn(`Failed to parse agent spec ${filePath}:`, err);
        }
      }
    } catch {
      /* directory doesn't exist */
    }
    return agents;
  }

  /** Scan the canonical agents/ directory (shared format across all providers) */
  private async scanCanonicalAgents(workingDir: string): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const canonicalDir = join(workingDir, 'agents');
    try {
      const entries = await readdir(canonicalDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
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
        } catch {}
      }
    } catch {}
    return agents;
  }
}

