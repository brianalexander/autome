import { writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { BaseProvider } from './base.js';
import type { CanonicalAgentSpec, VendorNotificationResult, DiscoveredAgent } from './types.js';

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

export class ClaudeCodeProvider extends BaseProvider {
  readonly name = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly supportsSessionResume = true;
  readonly tracksMcpReadiness = false;
  readonly mcpReadinessDelayMs = 5000;
  readonly sessionCreateTimeoutMs = 60000;

  protected readonly agentFileExtensions = ['.json', '.md'];

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

  protected parseAgentFile(content: string, fileName: string): DiscoveredAgent | null {
    if (fileName.endsWith('.md')) {
      const parsed = parseFrontmatter(content);
      if (!parsed) return null;
      const name = parsed.meta.name as string || fileName.replace(/\.md$/, '');
      return {
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
        source: 'local',
        path: '',
      };
    } else {
      // JSON agent files
      const raw = JSON.parse(content);
      const name = raw.name || fileName.replace(/\.[^.]+$/, '');
      return { name, spec: { name, ...raw }, source: 'local', path: '' };
    }
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
}
