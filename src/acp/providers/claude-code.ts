import { writeFile, mkdir, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { AcpProvider, AgentDiscoveryOptions, VendorNotificationResult, CanonicalAgentSpec } from '../provider/types.js';
import type { DiscoveredAgent } from '../../types/instance.js';

/** Parse YAML-like frontmatter from a Markdown string. Returns null if no frontmatter found. */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const [, yamlBlock, body] = match;
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    meta[key] = value;
  }

  return { meta, body: body.trim() };
}

export class ClaudeCodeProvider implements AcpProvider {
  readonly name = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly supportsSessionResume = true;
  readonly tracksMcpReadiness = false;
  readonly mcpReadinessDelayMs = 5000;
  readonly sessionCreateTimeoutMs = 60000;

  getCommand(): string {
    return 'npx';
  }

  getSpawnArgs(_options: { agent?: string; model?: string }): string[] {
    return ['-y', '@agentclientprotocol/claude-agent-acp@^0.24.2'];
  }

  getSpawnEnv(): Record<string, string> {
    return {};
  }

  getLocalAgentDir(workingDir: string): string {
    return join(workingDir, '.claude', 'agents');
  }

  getGlobalAgentDir(): string {
    return join(homedir(), '.claude', 'agents');
  }

  handleVendorNotification(_method: string, _params: Record<string, unknown>): VendorNotificationResult | null {
    return null;
  }

  /**
   * Write .claude/settings.json with bypassPermissions mode.
   * The claude-agent-acp adapter reads this to skip all permission prompts.
   * Merges with existing settings so user config is preserved.
   */
  async prepareWorkingDir(workDir: string): Promise<void> {
    const claudeDir = join(workDir, '.claude');
    await mkdir(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
      } catch {
        /* ignore parse errors — overwrite with clean settings */
      }
    }

    const settings = {
      ...existing,
      permissions: {
        ...(existing.permissions as Record<string, unknown> | undefined ?? {}),
        defaultMode: 'bypassPermissions',
      },
    };

    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  async writeAgentFile(dir: string, name: string, canonical: CanonicalAgentSpec, prompt: string): Promise<string> {
    const fileName = `${name}.md`;
    const filePath = join(dir, fileName);

    // Build YAML frontmatter
    const frontmatter: string[] = [];
    frontmatter.push(`name: ${canonical.name}`);
    if (canonical.description) frontmatter.push(`description: ${canonical.description}`);
    if (canonical.tools?.length) frontmatter.push(`tools: ${canonical.tools.join(', ')}`);
    if (canonical.model) frontmatter.push(`model: ${canonical.model}`);

    const content = `---\n${frontmatter.join('\n')}\n---\n\n${prompt}\n`;
    await writeFile(filePath, content, 'utf-8');
    return fileName;
  }

  async discoverAgents(opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    const seen = new Set<string>();

    // Workflow-scoped (bundles)
    if (opts?.workflowId) {
      const bundlesBase = opts.bundlesDir || join(process.cwd(), 'data', 'bundles');
      const bundleAgentDir = join(bundlesBase, opts.workflowId, 'agents');
      for (const agent of await this.scanAgentDir(bundleAgentDir, 'local')) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Provider-specific local
    const localDir = this.getLocalAgentDir(opts?.workingDir || process.cwd());
    for (const agent of await this.scanAgentDir(localDir, 'local')) {
      if (!seen.has(agent.name)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    // Canonical agents (agents/ directory)
    const canonicalDir = join(opts?.workingDir || process.cwd(), 'agents');
    try {
      const entries = await readdir(canonicalDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const specPath = join(canonicalDir, entry.name, 'agent.json');
        try {
          const content = await readFile(specPath, 'utf-8');
          const raw = JSON.parse(content);
          let prompt = '';
          try {
            prompt = await readFile(join(canonicalDir, entry.name, 'prompt.md'), 'utf-8');
          } catch {}
          const spec = { ...raw, prompt: prompt || raw.prompt || '' };
          agents.push({ name: raw.name || entry.name, spec, source: 'local', path: specPath });
          seen.add(raw.name || entry.name);
        } catch {}
      }
    } catch {}

    // Provider-specific global
    const globalDir = this.getGlobalAgentDir();
    for (const agent of await this.scanAgentDir(globalDir, 'global')) {
      if (!seen.has(agent.name)) {
        agents.push(agent);
        seen.add(agent.name);
      }
    }

    return agents;
  }

  async getAgentSpec(name: string, opts?: AgentDiscoveryOptions): Promise<DiscoveredAgent | null> {
    const agents = await this.discoverAgents(opts);
    return agents.find((a) => a.name === name) || null;
  }

  private async scanAgentDir(dir: string, source: 'local' | 'global'): Promise<DiscoveredAgent[]> {
    const agents: DiscoveredAgent[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.md')) continue;
        const filePath = join(dir, file);
        try {
          const content = await readFile(filePath, 'utf-8');

          if (file.endsWith('.md')) {
            // Parse YAML frontmatter from Markdown agent files
            const parsed = parseFrontmatter(content);
            if (parsed) {
              const name = parsed.meta.name as string || file.replace(/\.md$/, '');
              agents.push({
                name,
                spec: {
                  name,
                  description: parsed.meta.description as string | undefined,
                  model: parsed.meta.model as string | undefined,
                  tools: typeof parsed.meta.tools === 'string'
                    ? parsed.meta.tools.split(',').map((t: string) => t.trim())
                    : parsed.meta.tools as string[] | undefined,
                  prompt: parsed.body,
                  ...parsed.meta,
                },
                source,
                path: filePath,
              });
            }
          } else {
            // JSON agent files
            const raw = JSON.parse(content);
            const name = raw.name || file.replace(/\.[^.]+$/, '');
            agents.push({ name, spec: { name, ...raw }, source, path: filePath });
          }
        } catch {
          /* skip unparseable files */
        }
      }
    } catch {
      /* directory doesn't exist */
    }
    return agents;
  }
}
