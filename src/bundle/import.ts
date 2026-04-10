import { readFile } from 'fs/promises';

import type { OrchestratorDB } from '../db/database.js';
import type { Bundle, ImportResult, ImportWarning } from './types.js';
import { discoverAgents } from '../agents/discovery.js';

/**
 * Import a .autome bundle (plain JSON file).
 * Checks that required agents are installed locally, creates the workflow in the DB.
 */
export async function importWorkflow(
  archivePath: string,
  db: OrchestratorDB,
  options?: { force?: boolean; workingDir?: string },
): Promise<ImportResult> {
  // Read and parse the JSON bundle
  let bundle: Bundle;
  try {
    bundle = JSON.parse(await readFile(archivePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid bundle file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!bundle.workflow || !bundle.name) {
    throw new Error('Invalid bundle: missing workflow or name');
  }

  // Check what agents are installed locally
  const workDir = options?.workingDir || process.cwd();
  const installed = await discoverAgents(workDir);
  const installedNames = new Set(installed.map((a) => a.name));

  const warnings: ImportWarning[] = [];
  const missingAgents: string[] = [];

  for (const name of bundle.requiredAgents ?? []) {
    if (!installedNames.has(name)) {
      missingAgents.push(name);
      warnings.push({
        type: 'missing_agent',
        name,
        message: `Required agent "${name}" is not installed. Stages using it will fail at runtime until you create it.`,
      });
    }
  }

  // Hard fail if missing agents and not forced
  if (missingAgents.length > 0 && !options?.force) {
    throw new Error(
      `Cannot import: missing required agents: ${missingAgents.join(', ')}. Create these agents locally and re-import, or pass force=true to import anyway.`,
    );
  }

  // Create the workflow in the DB (strip the old ID — DB assigns a new one)
  const { id: _oldId, ...workflowData } = bundle.workflow;
  const created = db.createWorkflow(workflowData);

  return {
    workflowId: created.id,
    warnings,
  };
}

/**
 * Preview a .autome bundle without importing.
 */
export async function previewBundle(archivePath: string): Promise<{
  bundle: Bundle;
  workflow: { name: string; description?: string; stageCount: number; edgeCount: number };
}> {
  let bundle: Bundle;
  try {
    bundle = JSON.parse(await readFile(archivePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Invalid bundle file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!bundle.workflow || !bundle.name) {
    throw new Error('Invalid bundle: missing workflow or name');
  }

  return {
    bundle,
    workflow: {
      name: bundle.workflow.name,
      description: bundle.workflow.description,
      stageCount: bundle.workflow.stages.length,
      edgeCount: bundle.workflow.edges.length,
    },
  };
}
