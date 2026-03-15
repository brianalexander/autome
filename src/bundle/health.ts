/**
 * Workflow health checks — verifies that all external dependencies
 * (MCP server commands, hook binaries, secrets) are available on the system.
 * Runs on demand, not just at import time.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { discoverAgents } from '../agents/discovery.js';
import type { WorkflowDefinition } from '../types/workflow.js';
import type { KiroAgentSpec } from '../types/instance.js';

const execFileAsync = promisify(execFile);

export interface HealthWarning {
  type: 'missing_mcp_command' | 'missing_hook_command' | 'missing_secret' | 'missing_agent';
  severity: 'error' | 'warning';
  /** Which agent this warning relates to (null for workflow-level issues). */
  agentId: string | null;
  message: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  warnings: HealthWarning[];
  checkedAt: string;
}

/**
 * Check all external dependencies for a workflow definition.
 * Walks agent stages, resolves specs, checks commands and secrets.
 */
export async function checkWorkflowHealth(
  definition: WorkflowDefinition,
  options?: { workflowId?: string },
): Promise<HealthCheckResult> {
  const warnings: HealthWarning[] = [];
  const checkedCommands = new Set<string>();
  const checkedSecrets = new Set<string>();

  // Discover available agents (workflow-scoped if applicable)
  const agents = await discoverAgents(options?.workflowId ? { workflowId: options.workflowId } : undefined);

  for (const stage of definition.stages) {
    if (stage.type !== 'agent') continue;
    const agentId = stage.config?.agentId as string | undefined;
    if (!agentId) continue;

    const discovered = agents.find((a) => a.name === agentId);
    if (!discovered) {
      warnings.push({
        type: 'missing_agent',
        severity: 'error',
        agentId,
        message: `Agent "${agentId}" not found in any agent directory`,
      });
      continue;
    }

    const spec = discovered.spec;

    // Check MCP server commands
    if (spec.mcpServers) {
      for (const [serverName, serverConfig] of Object.entries(spec.mcpServers)) {
        const cmd = serverConfig.command;
        if (!cmd || checkedCommands.has(cmd)) continue;
        checkedCommands.add(cmd);

        const exists = await commandExists(cmd);
        if (!exists) {
          warnings.push({
            type: 'missing_mcp_command',
            severity: 'error',
            agentId,
            message: `MCP server "${serverName}" requires command "${cmd}" which was not found`,
          });
        }

        // Check env vars as potential secrets
        if (serverConfig.env) {
          for (const [key, value] of Object.entries(serverConfig.env)) {
            if (checkedSecrets.has(key)) continue;
            checkedSecrets.add(key);
            // Only warn if the value looks like a placeholder/reference (not a hardcoded value)
            if (isSecretReference(key, value)) {
              if (!process.env[key]) {
                warnings.push({
                  type: 'missing_secret',
                  severity: 'warning',
                  agentId,
                  message: `Environment variable "${key}" may be required but is not set`,
                });
              }
            }
          }
        }
      }
    }

    // Check hook commands
    if (spec.hooks) {
      for (const [hookName, hookEntries] of Object.entries(spec.hooks)) {
        if (!Array.isArray(hookEntries)) continue;
        for (const entry of hookEntries) {
          if (!entry?.command) continue;
          const cmd = entry.command.trim().split(/\s+/)[0];
          if (!cmd || checkedCommands.has(cmd)) continue;
          checkedCommands.add(cmd);

          const exists = await commandExists(cmd);
          if (!exists) {
            warnings.push({
              type: 'missing_hook_command',
              severity: 'warning',
              agentId,
              message: `Hook "${hookName}" requires command "${cmd}" which was not found`,
            });
          }
        }
      }
    }
  }

  return {
    healthy: warnings.length === 0,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/** Heuristic: env var is likely a secret if the key contains common secret patterns. */
function isSecretReference(key: string, value: string): boolean {
  const secretPatterns = /(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH|API_KEY)/i;
  return secretPatterns.test(key);
}
