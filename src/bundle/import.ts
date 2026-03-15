/**
 * Workflow import — extracts a .autome bundle into data/bundles/<workflowId>/,
 * rewrites all resource paths to workspace-local references, creates the
 * workflow in the database, and checks system dependencies.
 */
import { readFile, mkdir, writeFile, rm, cp } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as tar from 'tar';

import type { WorkflowDefinition } from '../types/workflow.js';
import type { OrchestratorDB } from '../db/database.js';
import { BUNDLE_FORMAT_VERSION, type BundleManifest, type ImportResult, type ImportWarning } from './types.js';
import { listProviders } from '../acp/provider/registry.js';

const execFileAsync = promisify(execFile);

interface ImportOptions {
  /** Base directory for bundle storage. Defaults to ./data/bundles */
  bundlesDir?: string;
}

/**
 * Import a .autome bundle archive.
 * Extracts to data/bundles/<workflowId>/, rewrites paths, creates the workflow.
 */
export async function importWorkflow(
  archivePath: string,
  db: OrchestratorDB,
  options?: ImportOptions,
): Promise<ImportResult> {
  const bundlesBase = options?.bundlesDir || join(process.cwd(), 'data', 'bundles');

  // Extract to a temporary location first to read the manifest
  const tempDir = join(bundlesBase, `_import-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    await tar.extract({ file: archivePath, cwd: tempDir });

    // Read and validate manifest
    const manifestPath = join(tempDir, 'bundle.json');
    if (!existsSync(manifestPath)) {
      throw new Error('Invalid bundle: missing bundle.json manifest');
    }

    const manifest: BundleManifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    if (manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
      throw new Error(
        `Bundle format version ${manifest.formatVersion} is newer than supported version ${BUNDLE_FORMAT_VERSION}. Please update autome.`,
      );
    }

    // Read workflow definition
    const workflowPath = join(tempDir, 'workflow.json');
    if (!existsSync(workflowPath)) {
      throw new Error('Invalid bundle: missing workflow.json');
    }

    const workflowDef: WorkflowDefinition = JSON.parse(await readFile(workflowPath, 'utf-8'));

    // Create the workflow in the database to get a stable ID
    const { id: _oldId, ...workflowData } = workflowDef;
    const created = db.createWorkflow(workflowData);
    const workflowId = created.id;

    // Move extracted files to the permanent bundle directory
    const bundleDir = join(bundlesBase, workflowId);
    await mkdir(bundleDir, { recursive: true });
    await cp(tempDir, bundleDir, { recursive: true });

    // Rewrite agent spec resource paths to point at the permanent location
    const importedAgents: string[] = [];
    const extractedResources: string[] = [];

    for (const [agentId, entry] of Object.entries(manifest.agents)) {
      const specPath = join(bundleDir, entry.spec);
      if (!existsSync(specPath)) {
        console.warn(`[import] Agent spec not found in bundle: ${entry.spec}`);
        continue;
      }

      const spec = JSON.parse(await readFile(specPath, 'utf-8'));
      const rewritten = rewriteAgentPaths(spec, bundleDir);
      await writeFile(specPath, JSON.stringify(rewritten, null, 2));

      importedAgents.push(agentId);
      extractedResources.push(...entry.resources);
    }

    // Check requirements
    const warnings = await checkRequirements(manifest);

    // Check provider compatibility
    const referencedProviders = new Set<string>();
    if (workflowDef.acpProvider) referencedProviders.add(workflowDef.acpProvider);
    for (const stage of workflowDef.stages) {
      // stage.config.overrides.acpProvider is where agent-level provider overrides live
      const stageOverrides = (stage.config as Record<string, unknown> | undefined)?.overrides as
        | Record<string, unknown>
        | undefined;
      const stageProvider = stageOverrides?.acpProvider;
      if (typeof stageProvider === 'string') referencedProviders.add(stageProvider);
    }

    if (referencedProviders.size > 0) {
      const available = await listProviders();
      const availableNames = new Set(available.map((p) => p.name));
      const missing = [...referencedProviders].filter((p) => !availableNames.has(p));
      if (missing.length > 0) {
        warnings.push({
          type: 'missing_dependency',
          message: `Workflow references providers not available on this system: ${missing.join(', ')}. Stages using these will fall back to your system default.`,
        });
      }
    }

    return {
      workflowId,
      importedAgents,
      extractedResources,
      warnings,
    };
  } finally {
    // Clean up temp directory (the permanent one stays)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Preview a bundle without importing — returns the manifest and workflow name.
 */
export async function previewBundle(archivePath: string): Promise<{
  manifest: BundleManifest;
  workflow: { name: string; description?: string; stageCount: number; edgeCount: number };
}> {
  const tempDir = join(process.cwd(), 'data', '_preview-' + Date.now());
  await mkdir(tempDir, { recursive: true });

  try {
    await tar.extract({ file: archivePath, cwd: tempDir });

    const manifest: BundleManifest = JSON.parse(await readFile(join(tempDir, 'bundle.json'), 'utf-8'));
    const workflow: WorkflowDefinition = JSON.parse(await readFile(join(tempDir, 'workflow.json'), 'utf-8'));

    return {
      manifest,
      workflow: {
        name: workflow.name,
        description: workflow.description,
        stageCount: workflow.stages.length,
        edgeCount: workflow.edges.length,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite all file://, skill://, and knowledgeBase paths in an agent spec
 * to point at the workspace-local bundle directory.
 */
type AgentResource = string | { type?: string; source?: string; [key: string]: unknown };

function rewriteAgentPaths(spec: Record<string, unknown>, bundleDir: string): Record<string, unknown> {
  const rewritten = structuredClone(spec);

  if (Array.isArray(rewritten.resources)) {
    rewritten.resources = (rewritten.resources as AgentResource[]).map((r) => {
      if (typeof r === 'string') {
        return rewriteUri(r, bundleDir);
      }
      if (r?.type === 'knowledgeBase' && r.source) {
        return {
          ...r,
          source: rewriteUri(r.source, bundleDir),
          autoUpdate: true, // Force re-index on the importer's machine
        };
      }
      return r;
    });
  }

  // Rewrite prompt if it's a file:// URI
  if (typeof rewritten.prompt === 'string' && rewritten.prompt.startsWith('file://')) {
    rewritten.prompt = rewriteUri(rewritten.prompt, bundleDir);
  }

  // Rewrite hook script paths
  if (rewritten.hooks) {
    for (const hookEntries of Object.values(rewritten.hooks)) {
      if (!Array.isArray(hookEntries)) continue;
      for (const entry of hookEntries as Array<{ command?: string }>) {
        if (!entry?.command) continue;
        // If the command contains a bundle-relative resource path, rewrite it
        entry.command = entry.command.replace(/resources\/[^\s]+/g, (match: string) => join(bundleDir, match));
      }
    }
  }

  return rewritten;
}

/**
 * Rewrite a file:// or skill:// URI to point at the absolute bundle path.
 */
function rewriteUri(uri: string, bundleDir: string): string {
  const schemeMatch = uri.match(/^(file|skill):\/\//);
  if (!schemeMatch) return uri;

  const scheme = schemeMatch[1];
  const path = uri.slice(schemeMatch[0].length);

  // If the path already starts with resources/ (bundle-internal), make it absolute
  if (path.startsWith('resources/')) {
    return `${scheme}://${join(bundleDir, path)}`;
  }

  return uri;
}

// ---------------------------------------------------------------------------
// Requirement checking
// ---------------------------------------------------------------------------

async function checkRequirements(manifest: BundleManifest): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  // Check system dependencies via `which`
  for (const dep of manifest.requirements.systemDependencies) {
    const exists = await commandExists(dep);
    if (!exists) {
      warnings.push({
        type: 'missing_dependency',
        message: `System command "${dep}" is required by agent hooks but was not found on this system`,
      });
    }
  }

  // Check MCP server commands via `which` — all kiro MCP servers are stdio (command-based)
  for (const server of manifest.requirements.mcpServers) {
    const exists = await commandExists(server);
    if (!exists) {
      warnings.push({
        type: 'missing_mcp_server',
        message: `MCP server command "${server}" is required but was not found on this system`,
      });
    }
  }

  // Note required secrets
  for (const secret of manifest.requirements.secrets) {
    if (!process.env[secret]) {
      warnings.push({
        type: 'missing_secret',
        message: `Environment variable "${secret}" is required but not currently set`,
      });
    }
  }

  return warnings;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}
