/**
 * Builds the SessionConfig for the AI Assistant agent.
 *
 * The assistant is a global singleton (not workflow-scoped) so it uses a fixed
 * stageId of 'global'. It connects to the assistant MCP server which provides
 * tools for inspecting workflow runs and taking corrective actions.
 */
import type { AgentPool } from '../../acp/pool.js';
import { config as appConfig } from '../../config.js';
import type { SessionConfig } from './agent-utils.js';
import { fromPackage } from '../../paths.js';

/**
 * Build a SessionConfig describing the AI Assistant session.
 *
 * - `instanceId='assistant'`, `stageId='global'` — single global session, not workflow-scoped.
 * - `cullKey='assistant:global'` keys the session manager.
 * - The MCP server (`assistant`) is injected via `additional_mcp_servers`.
 *
 * Note: this is a pure factory — it does not touch the pool or DB.
 */
export function buildAssistantSessionConfig(assistantPool: AgentPool): SessionConfig {
  const orchestratorPort = appConfig.port;
  return {
    pool: assistantPool,
    instanceId: 'assistant',
    stageId: 'global',
    iteration: 1,
    agentId: 'assistant',
    workingDir: process.cwd(),
    overrides: {
      additional_mcp_servers: [
        {
          name: 'assistant',
          command: 'node',
          args: [fromPackage('dist', 'mcp', 'assistant-server.js')],
          env: {
            ORCHESTRATOR_PORT: String(orchestratorPort),
          },
        },
      ],
    },
    eventPrefix: 'assistant',
    filterPayload: {},
    scope: undefined,
    cullKey: 'assistant:global',
  };
}
