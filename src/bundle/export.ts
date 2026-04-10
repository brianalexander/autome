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
 * The bundle contains the workflow definition + the names of agents it references.
 * Importers are responsible for having matching agents in their environment.
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

  // Warn about agents referenced but not installed locally — bundle still ships with the reference
  const workDir = options?.workingDir || process.cwd();
  const installed = await discoverAgents(workDir);
  const installedNames = new Set(installed.map((a) => a.name));

  const warnings: ExportWarning[] = [];
  for (const name of requiredAgents) {
    if (!installedNames.has(name)) {
      warnings.push({
        type: 'missing_agent',
        name,
        message: `Agent "${name}" is referenced by this workflow but not installed locally. The bundle will still include the reference.`,
      });
    }
  }

  const bundle: Bundle = {
    name: definition.name,
    description: definition.description,
    exportedAt: new Date().toISOString(),
    sourceProvider: config.acpProvider || 'kiro',
    workflow: definition,
    requiredAgents: [...requiredAgents].sort(),
  };

  // Write as a plain JSON file
  const archivePath = join(tmpdir(), `${slugify(definition.name)}.autome`);
  await writeFile(archivePath, JSON.stringify(bundle, null, 2), 'utf-8');

  return { archivePath, bundle, warnings };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';
}
