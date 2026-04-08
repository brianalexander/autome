import { readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { BaseProvider } from './base.js';
import type { CanonicalAgentSpec, VendorNotificationResult, DiscoveredAgent } from './types.js';
import { KiroAgentSpecSchema } from '../../types/instance.js';

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
      return { type: 'mcp_server_initialized', serverName: (params.serverName as string | undefined) ?? 'unknown' };
    }
    if (method === '_kiro.dev/mcp/server_init_failure') {
      return {
        type: 'mcp_server_failed',
        serverName: (params.serverName as string | undefined) ?? 'unknown',
        error: (params.error as string | undefined) ?? 'Unknown error',
      };
    }
    if (method === '_kiro.dev/commands/available') {
      const serverList = params.mcpServers;
      const servers = Array.isArray(serverList)
        ? (serverList as Array<{ name?: string; status?: string }>).map((s) => ({
            name: String(s.name ?? ''),
            status: s.status,
          }))
        : [];
      return { type: 'mcp_server_list', servers };
    }
    if (method === '_kiro.dev/metadata') {
      return { type: 'metadata', data: params };
    }
    if (method === '_kiro.dev/compaction/status') {
      return { type: 'compaction', data: params };
    }
    return null;
  }

  /** Drop kiro-cli's spurious empty-body parse-error notifications */
  filterIncomingMessage(msg: unknown): boolean {
    if (
      msg !== null &&
      typeof msg === 'object' &&
      'error' in msg &&
      typeof (msg as Record<string, unknown>).error === 'object' &&
      (msg as { error: { code?: number; data?: unknown } }).error?.code === -32700 &&
      (msg as { error: { code?: number; data?: unknown } }).error?.data === ''
    ) {
      return false;
    }
    return true;
  }

  isRetryableError(err: Error): boolean {
    return err.message?.includes('not idle') ?? false;
  }

  extractModelName(sessionResult: unknown): string | null {
    if (!sessionResult || typeof sessionResult !== 'object') return null;
    const configOptions = (sessionResult as Record<string, unknown>).configOptions;
    if (!Array.isArray(configOptions)) return null;

    const modelOption = configOptions.find(
      (opt: unknown) => opt && typeof opt === 'object' && (opt as Record<string, unknown>).category === 'model',
    );
    if (!modelOption) return null;

    const raw = modelOption as Record<string, unknown>;
    const currentValue = typeof raw.currentValue === 'string' ? raw.currentValue : (typeof raw.value === 'string' ? raw.value : null);
    if (!currentValue) return null;

    let displayName = currentValue;
    const options = raw.options;
    if (Array.isArray(options)) {
      const selected = options.find(
        (o: unknown) => o && typeof o === 'object' && (o as Record<string, unknown>).value === currentValue,
      ) as Record<string, unknown> | undefined;
      if (selected) {
        const desc = typeof selected.description === 'string' ? selected.description : '';
        const modelMatch = desc.match(/^([\w.]+ [\d.]+)/);
        if (modelMatch) {
          displayName = modelMatch[1];
        } else if (typeof selected.name === 'string') {
          displayName = selected.name.replace(/\s*\(.*?\)\s*$/, '').trim();
        }
      }
    }

    return displayName;
  }

  getProtocolVersion(): number {
    return 1;
  }

  getClientCapabilities(): Record<string, unknown> {
    return {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    };
  }

  protected parseAgentFile(content: string, fileName: string): DiscoveredAgent | null {
    const spec = KiroAgentSpecSchema.parse(JSON.parse(content));
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
    if (canonical.toolsSettings) config.toolsSettings = canonical.toolsSettings;
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
