/**
 * Builds the SessionConfig for the AI Author agent.
 *
 * Extracted into its own module so non-route code (e.g. the message-injector)
 * can construct an author session config without pulling in the full route
 * registration closure (and without creating a circular import).
 */
import type { AgentPool } from '../../acp/pool.js';
import { config as appConfig } from '../../config.js';
import type { SessionConfig } from './agent-utils.js';
import { fromPackage } from '../../paths.js';

/**
 * Build a SessionConfig describing the AI Author session for a given workflow.
 *
 * - `instanceId='author'`, `stageId=workflowId` is the convention used by the
 *   author pool and the segments table.
 * - `cullKey='author:{workflowId}'` keys the session manager.
 * - The MCP server (`workflow_author`) is injected via `additional_mcp_servers`.
 *
 * Note: this is a pure factory — it does not touch the pool or DB. Pass the
 * actual pool you want the session to use (in practice always `state.authorPool`).
 */
export function buildAuthorSessionConfig(authorPool: AgentPool, workflowId: string): SessionConfig {
  const orchestratorPort = appConfig.port;
  return {
    pool: authorPool,
    instanceId: 'author',
    stageId: workflowId,
    iteration: 1,
    agentId: 'workflow-author',
    // Use project root as cwd so the SDK discovers .claude/agents/ for
    // agent identity and sub-agent restrictions. Runtime agents use isolated
    // workspaces (for imported bundles), but the author is part of the project.
    workingDir: process.cwd(),
    overrides: {
      additional_mcp_servers: [
        {
          name: 'workflow_author',
          command: 'node',
          args: [fromPackage('dist', 'mcp', 'workflow-author-server.js')],
          env: {
            ORCHESTRATOR_PORT: String(orchestratorPort),
          },
        },
      ],
    },
    eventPrefix: 'author',
    filterPayload: { workflowId },
    scope: { workflowId },
    cullKey: `author:${workflowId}`,
  };
}
