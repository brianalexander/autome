import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import type { WorkflowDefinition } from '../types/workflow.js';
import type { Bundle } from './types.js';
import type { ExportWarning } from './types.js';
import { discoverAgents } from '../agents/discovery.js';
import { config } from '../config.js';

export type { ExportWarning };

/**
 * Export a workflow as a .autome bundle (plain JSON).
 * Collects required agent names and their MCP server names from locally installed agents.
 */
export async function exportWorkflow(
  definition: WorkflowDefinition,
  options?: { workingDir?: string },
): Promise<{ archivePath: string; bundle: Bundle; warnings: ExportWarning[] }> {
  // Collect referenced agent names from agent stages
  const requiredAgents = new Set<string>();
  for (const stage of definition.stages) {
    if (stage.type === 'agent') {
      const agentId = (stage.config as Record<string, unknown> | undefined)?.agentId;
      if (typeof agentId === 'string') requiredAgents.add(agentId);
    }
  }

  // Discover what's installed locally to validate references and find MCP names
  const workDir = options?.workingDir || process.cwd();
  const installed = await discoverAgents(workDir);
  const installedMap = new Map(installed.map((a) => [a.name, a]));

  // Warn about agents referenced but not installed locally
  const warnings: ExportWarning[] = [];
  for (const name of requiredAgents) {
    if (!installedMap.has(name)) {
      warnings.push({
        type: 'missing_agent',
        name,
        message: `Agent "${name}" is referenced by this workflow but not installed locally. The bundle will still include the reference.`,
      });
    }
  }

  // Collect MCP server names from installed agent specs that this workflow uses
  const requiredMcpServers = new Set<string>();
  for (const name of requiredAgents) {
    const agent = installedMap.get(name);
    if (!agent) continue;
    const mcpServers = (agent.spec as { mcpServers?: Record<string, unknown> }).mcpServers;
    if (mcpServers) {
      for (const serverName of Object.keys(mcpServers)) {
        requiredMcpServers.add(serverName);
      }
    }
  }

  const bundle: Bundle = {
    name: definition.name,
    description: definition.description,
    exportedAt: new Date().toISOString(),
    sourceProvider: config.acpProvider || 'kiro',
    workflow: definition,
    requiredAgents: [...requiredAgents].sort(),
    requiredMcpServers: [...requiredMcpServers].sort(),
  };

  // Write as a plain JSON file
  const archivePath = join(tmpdir(), `${slugify(definition.name)}.autome`);
  await writeFile(archivePath, JSON.stringify(bundle, null, 2), 'utf-8');

  return { archivePath, bundle, warnings };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';
}
