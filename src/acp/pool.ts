import { AcpClient, type McpServerConfig } from './client.js';
import { mkdir, symlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { MCPServerConfig } from '../types/workflow.js';
import { config, DEFAULT_ACP_PROVIDER } from '../config.js';
import type { AcpProvider } from './provider/types.js';
import { createProvider } from './provider/registry.js';

export interface AgentStageConfig {
  agentId: string;
  overrides?: {
    model?: string;
    additional_prompt?: string;
    additional_tools?: string[];
    additional_mcp_servers?: MCPServerConfig[];
  };
}

export interface SpawnOptions {
  instanceId: string;
  stageId: string;
  config: AgentStageConfig;
  workingDir?: string;
  orchestratorPort?: number;
  /** If provided, loadSession is used instead of newSession */
  acpSessionId?: string;
  /** Workflow definition ID — used to symlink bundle agents into the working directory for provider agent discovery. */
  definitionId?: string;
  /** Override the pool's default provider for this specific spawn. */
  providerOverride?: AcpProvider;
}

export interface SpawnResult {
  client: AcpClient;
  /** True if loadSession succeeded and the provider has the full conversation history. */
  sessionLoaded: boolean;
}

interface PoolEntry {
  client: AcpClient;
  sessionId: string | null;
}

export class AgentPool {
  private processes: Map<string, PoolEntry> = new Map();
  private provider: AcpProvider;
  private baseWorkDir: string;

  constructor(options?: { provider?: AcpProvider; baseWorkDir?: string }) {
    // Provider should always be passed explicitly — server.ts initializes it before constructing pools.
    // The createProvider() fallback here supports built-in providers only.
    this.provider = options?.provider || createProvider(config.acpProvider ?? DEFAULT_ACP_PROVIDER);
    this.baseWorkDir = options?.baseWorkDir || join(process.cwd(), 'data', 'workspaces');
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const { instanceId, stageId, config: stageConfig, orchestratorPort = config.port } = options;
    const key = `${instanceId}:${stageId}`;

    // Terminate existing process for this stage if any
    if (this.processes.has(key)) {
      await this.terminate(instanceId, stageId);
    }

    const effectiveProvider = options.providerOverride || this.provider;

    // Create working directory
    const workDir = options.workingDir || join(this.baseWorkDir, instanceId, stageId);
    await mkdir(workDir, { recursive: true });

    // Let the provider write any config files it needs before the process starts
    if (effectiveProvider.prepareWorkingDir) {
      await effectiveProvider.prepareWorkingDir(workDir);
    }

    // If this workflow has bundled agents, symlink them into the working directory
    // so the provider's CLI discovers them via its local agent dir
    if (options.definitionId) {
      const bundleAgentsDir = join(process.cwd(), 'data', 'bundles', options.definitionId, 'agents');
      if (existsSync(bundleAgentsDir)) {
        const targetDir = effectiveProvider.getLocalAgentDir(workDir);
        if (!existsSync(targetDir)) {
          await mkdir(join(targetDir, '..'), { recursive: true });
          await symlink(bundleAgentsDir, targetDir, 'dir').catch(() => {
            // Symlink may fail on some systems — fall back silently
            console.warn(`[pool] Could not symlink bundle agents for ${options.definitionId}`);
          });
        }
      }
    }

    // Build intermediate MCP server list (flat env map for convenience)
    const mcpServersIntermediate: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> = [
      {
        name: 'workflow_control',
        command: 'node',
        args: [join(process.cwd(), 'dist', 'mcp', 'workflow-control-server.js')],
        env: {
          WORKFLOW_INSTANCE_ID: instanceId,
          STAGE_ID: stageId,
          ORCHESTRATOR_PORT: String(orchestratorPort),
        },
      },
    ];

    for (const server of stageConfig.overrides?.additional_mcp_servers ?? []) {
      mcpServersIntermediate.push({
        name: server.name,
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      });
    }

    // Format MCP servers for ACP protocol (env as array of name/value pairs)
    const acpMcpServers: McpServerConfig[] = mcpServersIntermediate.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: s.env ? Object.entries(s.env).map(([name, value]) => ({ name, value })) : [],
    }));

    // Create and start client
    const client = new AcpClient({ provider: effectiveProvider, workingDir: workDir });

    try {
      await client.start({ agent: stageConfig.agentId, model: stageConfig.overrides?.model });

      let sessionId: string | null = null;
      let sessionLoaded = false;

      // Build session meta for providers that support it (e.g., Claude's _meta field)
      const sessionMeta: Record<string, unknown> = {};
      if (stageConfig.agentId) sessionMeta.agent = stageConfig.agentId;
      if (stageConfig.overrides?.model) sessionMeta.model = stageConfig.overrides.model;
      const meta = Object.keys(sessionMeta).length > 0 ? sessionMeta : undefined;

      if (options.acpSessionId && effectiveProvider.supportsSessionResume) {
        // Try to resume — provider replays the full conversation on success
        try {
          const info = await client.loadSession(options.acpSessionId, acpMcpServers);
          sessionId = info.sessionId;
          sessionLoaded = true;
        } catch (err) {
          console.warn(`[pool] loadSession failed, falling back to newSession:`, err);
          const info = await client.newSession(acpMcpServers, undefined, meta);
          sessionId = info.sessionId;
        }
      } else {
        const info = await client.newSession(acpMcpServers, undefined, meta);
        sessionId = info.sessionId;
      }

      this.processes.set(key, { client, sessionId });
      return { client, sessionLoaded };
    } catch (err) {
      client.destroy({ immediate: true });
      throw err;
    }
  }

  getClient(instanceId: string, stageId: string): AcpClient | undefined {
    return this.processes.get(`${instanceId}:${stageId}`)?.client;
  }

  getSessionId(instanceId: string, stageId: string): string | null {
    return this.processes.get(`${instanceId}:${stageId}`)?.sessionId ?? null;
  }

  async terminate(instanceId: string, stageId: string): Promise<void> {
    const key = `${instanceId}:${stageId}`;
    const entry = this.processes.get(key);
    if (entry) {
      entry.client.destroy();
      this.processes.delete(key);
    }
  }

  async terminateAll(options?: { immediate?: boolean }): Promise<void> {
    for (const entry of this.processes.values()) {
      entry.client.destroy(options);
    }
    this.processes.clear();
  }

  getActiveCount(): number {
    return this.processes.size;
  }

  /** Update the provider used for future spawns. Does not affect already-running processes. */
  setProvider(provider: AcpProvider): void {
    this.provider = provider;
  }
}

