import { readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { AcpProvider, AgentDiscoveryOptions, VendorNotificationResult, CanonicalAgentSpec } from '../provider/types.js';
import type { DiscoveredAgent } from '../../types/instance.js';
import { KiroAgentSpecSchema } from '../../types/instance.js';

export class KiroProvider implements AcpProvider {
  readonly name = 'kiro';
  readonly displayName = 'Kiro';
  readonly supportsSessionResume = true;
  readonly tracksMcpReadiness = true; // sends _kiro.dev/mcp/server_initialized notifications

  getCommand(): string {
    return process.env.KIRO_CLI_PATH || 'kiro-cli';
  }

  getSpawnArgs(options: { agent?: string; model?: string }): string[] {
    const args = ['acp', '--trust-all-tools'];
    if (options.agent) args.push('--agent', options.agent);
    if (options.model) args.push('--model', options.model);
    return args;
  }

  getSpawnEnv(): Record<string, string> {
    return {};
  }

  getLocalAgentDir(workingDir: string): string {
    return join(workingDir, '.kiro', 'agents');
  }

  getGlobalAgentDir(): string {
    return join(homedir(), '.kiro', 'agents');
  }

  handleVendorNotification(method: string, params: Record<string, unknown>): VendorNotificationResult | null {
    if (method === '_kiro.dev/mcp/server_initialized') {
      return { event: 'vendor:mcp_server_initialized', data: params };
    }
    if (method === '_kiro.dev/mcp/server_init_failure') {
      return { event: 'vendor:mcp_server_init_failure', data: params };
    }
    if (method === '_kiro.dev/commands/available') {
      return { event: 'vendor:commands_available', data: params };
    }
    if (method === '_kiro.dev/metadata') {
      return { event: 'vendor:metadata', data: params };
    }
    if (method === '_kiro.dev/compaction/status') {
      return { event: 'vendor:compaction', data: params };
    }
    return null;
  }

  async writeAgentFile(dir: string, name: string, canonical: CanonicalAgentSpec, prompt: string): Promise<string> {
    const fileName = `${name}.json`;
    const filePath = join(dir, fileName);

    const config: Record<string, unknown> = {
      name: canonical.name,
      description: canonical.description,
      prompt,
      tools: canonical.tools || [],
      allowedTools: canonical.tools || [],
      includeMcpJson: true,
    };
    if (canonical.model) config.model = canonical.model;
    if (canonical.mcp_servers) {
      const mcpServers: Record<string, unknown> = {};
      for (const [sname, server] of Object.entries(canonical.mcp_servers)) {
        mcpServers[sname] = { command: server.command, args: server.args };
      }
      config.mcpServers = mcpServers;
    }

    await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return fileName;
  }

  async discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const seen = new Set<string>();

    // Workflow-scoped agents (highest priority — from imported bundles)
    if (opts?.workflowId) {
      const bundlesBase = opts.bundlesDir || join(process.cwd(), 'data', 'bundles');
      const bundleAgentDir = join(bundlesBase, opts.workflowId, 'agents');
      for (const agent of await this.scanAgentDir(bundleAgentDir, 'local')) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Local agents (project-level)
    const localDir = this.getLocalAgentDir(opts?.workingDir || process.cwd());
    for (const agent of await this.scanAgentDir(localDir, 'local')) {
      if (!seen.has(agent.name)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Global agents
    const globalDir = this.getGlobalAgentDir();
    for (const agent of await this.scanAgentDir(globalDir, 'global')) {
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

  async cleanupSessionLocks(): Promise<void> {
    const lockDir = join(homedir(), '.kiro', 'sessions', 'cli');
    try {
      const files = await readdir(lockDir);
      for (const file of files) {
        if (file.endsWith('.lock')) {
          await rm(join(lockDir, file), { force: true }).catch(() => {});
        }
      }
    } catch {
      /* dir may not exist */
    }
  }

  private async scanAgentDir(dir: string, source: 'local' | 'global'): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const spec = KiroAgentSpecSchema.parse(JSON.parse(content));
          const name = spec.name || file.replace('.json', '');
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
