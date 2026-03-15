import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { AcpProvider, AgentDiscoveryOptions, VendorNotificationResult, CanonicalAgentSpec } from '../provider/types.js';
import type { DiscoveredAgent } from '../../types/instance.js';

export class OpenCodeProvider implements AcpProvider {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly supportsSessionResume = true; // OpenCode persists sessions to SQLite and supports session/load over ACP JSON-RPC
  readonly tracksMcpReadiness = false; // OpenCode doesn't send vendor MCP init notifications
  readonly mcpReadinessDelayMs = 3000;

  getCommand(): string {
    return process.env.OPENCODE_BIN || 'opencode';
  }

  getSpawnArgs(_options: { agent?: string; model?: string }): string[] {
    // OpenCode uses `opencode acp` — agent selection is done via config, not CLI flags
    return ['acp'];
  }

  getSpawnEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (process.env.OPENCODE_URL) {
      env.OPENCODE_URL = process.env.OPENCODE_URL;
    }
    return env;
  }

  getLocalAgentDir(workingDir: string): string {
    return join(workingDir, '.opencode', 'agents');
  }

  getGlobalAgentDir(): string {
    return join(homedir(), '.config', 'opencode', 'agents');
  }

  handleVendorNotification(_method: string, _params: Record<string, unknown>): VendorNotificationResult | null {
    // OpenCode doesn't have documented vendor-specific notifications
    return null;
  }

  async writeAgentFile(dir: string, name: string, canonical: CanonicalAgentSpec, prompt: string): Promise<string> {
    const fileName = `${name}.json`;
    const filePath = join(dir, fileName);

    const config: Record<string, unknown> = {
      name: canonical.name,
      description: canonical.description,
      prompt,
      permission: 'allow',
    };
    if (canonical.model) config.model = canonical.model;

    await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return fileName;
  }

  async discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const seen = new Set<string>();

    // Workflow-scoped agents (from bundles — same as kiro since bundles are our format)
    if (opts?.workflowId) {
      const bundlesBase = opts.bundlesDir || join(process.cwd(), 'data', 'bundles');
      const bundleAgentDir = join(bundlesBase, opts.workflowId, 'agents');
      for (const agent of await this.scanAgentDir(bundleAgentDir, 'local')) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Local agents
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

  private stripJsoncComments(content: string): string {
    let result = '';
    let i = 0;
    let inString = false;
    let escaped = false;

    while (i < content.length) {
      const ch = content[i];

      if (inString) {
        result += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        i++;
        continue;
      }

      if (ch === '"') {
        inString = true;
        result += ch;
        i++;
        continue;
      }

      // Line comment
      if (ch === '/' && content[i + 1] === '/') {
        // Skip to end of line
        while (i < content.length && content[i] !== '\n') i++;
        continue;
      }

      // Block comment
      if (ch === '/' && content[i + 1] === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
        i += 2; // skip closing */
        continue;
      }

      result += ch;
      i++;
    }

    return result;
  }

  private async scanAgentDir(dir: string, source: 'local' | 'global'): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.jsonc')) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const cleaned = this.stripJsoncComments(content);
          const raw = JSON.parse(cleaned);

          // Normalize OpenCode agent spec to our internal DiscoveredAgent format
          const name = (raw.name as string | undefined) || file.replace(/\.jsonc?$/, '');
          const spec = {
            name,
            description: raw.description,
            prompt: raw.prompt,
            model: raw.model,
            tools: raw.tools,
            // Preserve all OpenCode-specific fields
            ...raw,
          };

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
