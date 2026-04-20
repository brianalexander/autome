/**
 * Regression test: ensures that buildAuthorSessionConfig and
 * buildAssistantSessionConfig use the explicitly-passed orchestratorPort
 * rather than the static config.port default.
 *
 * The bug: config.port is initialized once at module load from
 * process.env.PORT (defaulting to 3001). When the server starts on a
 * different port via --port / resolvedConfig.port, the MCP children
 * received ORCHESTRATOR_PORT=3001 and failed every request.
 */
import { describe, it, expect } from 'vitest';
import { AgentPool } from '../../../acp/pool.js';
import { buildAuthorSessionConfig } from '../author-session-config.js';
import { buildAssistantSessionConfig } from '../assistant-session-config.js';

const NON_DEFAULT_PORT = 54321;

describe('buildAuthorSessionConfig', () => {
  it('uses the passed orchestratorPort, not the static config.port default', () => {
    const pool = new AgentPool();
    const config = buildAuthorSessionConfig(pool, 'wf-test', NON_DEFAULT_PORT);

    const workflowAuthorServer = config.overrides?.additional_mcp_servers?.find(
      (s) => s.name === 'workflow_author',
    );
    expect(workflowAuthorServer).toBeDefined();
    expect(workflowAuthorServer?.env?.ORCHESTRATOR_PORT).toBe(String(NON_DEFAULT_PORT));
    expect(workflowAuthorServer?.env?.ORCHESTRATOR_PORT).not.toBe('3001');

    // SessionConfig.orchestratorPort must also be set so ensureSession threads
    // it through to pool.spawn correctly.
    expect(config.orchestratorPort).toBe(NON_DEFAULT_PORT);
  });
});

describe('buildAssistantSessionConfig', () => {
  it('uses the passed orchestratorPort, not the static config.port default', () => {
    const pool = new AgentPool();
    const config = buildAssistantSessionConfig(pool, NON_DEFAULT_PORT);

    const assistantServer = config.overrides?.additional_mcp_servers?.find(
      (s) => s.name === 'assistant',
    );
    expect(assistantServer).toBeDefined();
    expect(assistantServer?.env?.ORCHESTRATOR_PORT).toBe(String(NON_DEFAULT_PORT));
    expect(assistantServer?.env?.ORCHESTRATOR_PORT).not.toBe('3001');

    expect(config.orchestratorPort).toBe(NON_DEFAULT_PORT);
  });
});
