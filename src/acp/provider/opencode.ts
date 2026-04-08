import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { BaseProvider } from './base.js';
import type { CanonicalAgentSpec, VendorNotificationResult, DiscoveredAgent } from './types.js';

export class OpenCodeProvider extends BaseProvider {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly supportsSessionResume = true; // OpenCode persists sessions to SQLite and supports session/load over ACP JSON-RPC
  readonly tracksMcpReadiness = false; // OpenCode doesn't send vendor MCP init notifications
  readonly mcpReadinessDelayMs = 3000;

  protected readonly agentFileExtensions = ['.json', '.jsonc'];

  getCommand(): string {
    return process.env.OPENCODE_BIN || 'opencode';
  }

  getSpawnArgs(options: { agent?: string; model?: string }): string[] {
    // OpenCode uses `opencode acp` — agent and model selection are not supported as
    // CLI flags in the `acp` subcommand. They must be configured via agent config files
    // (agent is selected by the session/new prompt) or OpenCode's config file.
    if (options.agent) {
      console.warn(`[opencode] agent="${options.agent}" requested but OpenCode ACP does not support --agent CLI flag; configure via agent file instead`);
    }
    if (options.model) {
      console.warn(`[opencode] model="${options.model}" requested but OpenCode ACP does not support --model CLI flag; configure via opencode config instead`);
    }
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

  protected parseAgentFile(content: string, fileName: string): DiscoveredAgent | null {
    const cleaned = this.stripJsoncComments(content);
    const raw = JSON.parse(cleaned);

    // Normalize OpenCode agent spec to our internal DiscoveredAgent format
    const name = (raw.name as string | undefined) || fileName.replace(/\.jsonc?$/, '');
    const spec = {
      name,
      description: raw.description,
      prompt: raw.prompt,
      model: raw.model,
      tools: raw.tools,
      // Preserve all OpenCode-specific fields
      ...raw,
    };

    return { name, spec, source: 'local', path: '' };
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
    // Note: toolsSettings.subagent.availableAgents (sub-agent restrictions) are not
    // supported by the OpenCode provider — OpenCode has no equivalent concept yet.

    await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    return fileName;
  }
}
