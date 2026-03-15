import { readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { BaseProvider } from './base.js';
import type { CanonicalAgentSpec, VendorNotificationResult, DiscoveredAgent } from './types.js';
import type { KiroAgentSpec } from '../../types/instance.js';

export class KiroProvider extends BaseProvider {
  readonly name = 'kiro';
  readonly displayName = 'Kiro';
  readonly supportsSessionResume = true;
  readonly tracksMcpReadiness = true; // sends _kiro.dev/mcp/server_initialized notifications

  protected readonly agentFileExtensions = ['.json'];

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

  protected parseAgentFile(content: string, fileName: string): DiscoveredAgent | null {
    const spec = JSON.parse(content) as KiroAgentSpec;
    const name = spec.name || fileName.replace(/\.json$/, '');
    // source and path are set by the base scanAgentDir
    return { name, spec, source: 'local', path: '' };
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
}
