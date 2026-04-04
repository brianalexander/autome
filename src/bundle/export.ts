/**
 * Workflow export — bundles a workflow definition with all its agent specs,
 * resources, skills, knowledge base sources, and hook scripts into a
 * self-contained .autome archive (tar.gz).
 */
import { readFile, stat, mkdtemp, rm, writeFile, mkdir, copyFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { tmpdir, homedir } from 'os';
import { existsSync } from 'fs';
import * as tar from 'tar';
import { glob } from 'glob';

import type { WorkflowDefinition } from '../types/workflow.js';
import type { KiroAgentSpec } from '../types/instance.js';
import { discoverAgents } from '../agents/discovery.js';
import {
  BUNDLE_FORMAT_VERSION,
  classifyPathOrigin,
  stripRootAnchor,
  type BundleManifest,
  type BundleAgentEntry,
  type BundleRequirements,
  type PathOrigin,
} from './types.js';

interface ExportOptions {
  /** Working directory for resolving relative paths. Defaults to cwd. */
  workingDir?: string;
}

export interface ExportWarning {
  type: 'missing_agent';
  agentId: string;
  message: string;
}

/**
 * Export a workflow as a .autome bundle.
 * Returns the path to the generated tar.gz file and any warnings (e.g. missing agents).
 */
export async function exportWorkflow(
  definition: WorkflowDefinition,
  options?: ExportOptions,
): Promise<{ archivePath: string; manifest: BundleManifest; warnings: ExportWarning[] }> {
  const workDir = options?.workingDir || process.cwd();
  const stagingDir = await mkdtemp(join(tmpdir(), 'autome-export-'));

  try {
    // Create staging directory structure
    await mkdir(join(stagingDir, 'agents'), { recursive: true });
    await mkdir(join(stagingDir, 'resources'), { recursive: true });

    // Write workflow definition
    await writeFile(join(stagingDir, 'workflow.json'), JSON.stringify(definition, null, 2));

    const agents: Record<string, BundleAgentEntry> = {};
    const exportWarnings: ExportWarning[] = [];
    const requirements: BundleRequirements = {
      mcpServers: [],
      systemDependencies: [],
      secrets: [],
    };

    const seenMcp = new Set<string>();
    const seenDeps = new Set<string>();
    const seenSecrets = new Set<string>();

    // Discover all available agents
    const discoveredAgents = await discoverAgents(workDir);

    // Walk all agent stages
    for (const stage of definition.stages) {
      if (stage.type !== 'agent') continue;
      const agentId = stage.config?.agentId as string | undefined;
      if (!agentId || agents[agentId]) continue; // Skip duplicates

      const discovered = discoveredAgents.find((a) => a.name === agentId);
      if (!discovered) {
        const warning: ExportWarning = {
          type: 'missing_agent',
          agentId,
          message: `Agent "${agentId}" was not found in any agent directory and will not be included in the bundle`,
        };
        exportWarnings.push(warning);
        console.warn(`[export] ${warning.message}`);
        continue;
      }

      const spec = structuredClone(discovered.spec);
      const specDir = dirname(discovered.path);
      const bundledResources: string[] = [];

      // --- Bundle resources ---
      // Resources can be string URIs (file://, skill://) or object descriptors (knowledgeBase)
      type AgentResource = string | { type: string; source?: string; name?: string; [key: string]: unknown };
      if (spec.resources) {
        const rewrittenResources: AgentResource[] = [];
        for (const resource of spec.resources as AgentResource[]) {
          if (typeof resource === 'string') {
            // file:// or skill:// URI
            const scheme = resource.startsWith('skill://') ? 'skill' : 'file';
            const rewritten = await bundleUriResources(
              resource,
              scheme,
              agentId,
              specDir,
              workDir,
              stagingDir,
              bundledResources,
            );
            rewrittenResources.push(rewritten);
          } else if (resource?.type === 'knowledgeBase') {
            // Knowledge base — bundle source directory
            const rewritten = await bundleKnowledgeBase(
              resource,
              agentId,
              specDir,
              workDir,
              stagingDir,
              bundledResources,
            );
            rewrittenResources.push(rewritten);
          } else {
            rewrittenResources.push(resource);
          }
        }
        // Resources can be string URIs or object descriptors at runtime (schema is broader than type)
        spec.resources = rewrittenResources as unknown as string[];
      }

      // --- Bundle prompt if it's a file:// URI ---
      if (spec.prompt && spec.prompt.startsWith('file://')) {
        const rewritten = await bundleUriResources(
          spec.prompt,
          'file',
          agentId,
          specDir,
          workDir,
          stagingDir,
          bundledResources,
        );
        spec.prompt = rewritten;
      }

      // --- Bundle hook scripts ---
      if (spec.hooks) {
        for (const [hookName, hookEntries] of Object.entries(spec.hooks)) {
          if (!Array.isArray(hookEntries)) continue;
          for (const entry of hookEntries) {
            if (!entry?.command) continue;
            const { binary, scriptPath } = parseHookCommand(entry.command);

            // Track system dependency
            if (binary && !seenDeps.has(binary)) {
              seenDeps.add(binary);
              requirements.systemDependencies.push(binary);
            }

            // Try to bundle the script file
            if (scriptPath) {
              const resolved = resolveFilePath(scriptPath, specDir, workDir);
              if (resolved && existsSync(resolved)) {
                const origin = classifyScriptOrigin(scriptPath);
                const stripped = stripRootAnchor(scriptPath);
                const bundlePath = `resources/${agentId}/hooks/${origin}/${stripped}`;
                const destPath = join(stagingDir, bundlePath);
                await mkdir(dirname(destPath), { recursive: true });
                await copyFile(resolved, destPath);
                bundledResources.push(bundlePath);
                // Rewrite command to use bundle-relative path
                entry.command = entry.command.replace(scriptPath, bundlePath);
              }
            }
          }
        }
      }

      // --- Collect MCP server commands + secrets ---
      if (spec.mcpServers) {
        for (const [_name, server] of Object.entries(spec.mcpServers)) {
          // Track the command binary — this is what needs to be installed (stdio transport)
          const cmd = server.command;
          if (cmd && !seenMcp.has(cmd)) {
            seenMcp.add(cmd);
            requirements.mcpServers.push(cmd);
          }
          // Track env vars as potential secrets
          if (server.env) {
            for (const key of Object.keys(server.env)) {
              if (!seenSecrets.has(key)) {
                seenSecrets.add(key);
                requirements.secrets.push(key);
              }
            }
          }
        }
      }

      // Write the (rewritten) agent spec
      const specBundlePath = `agents/${agentId}.json`;
      await writeFile(join(stagingDir, specBundlePath), JSON.stringify(spec, null, 2));

      agents[agentId] = {
        spec: specBundlePath,
        resources: bundledResources,
      };
    }

    // Build manifest
    const manifest: BundleManifest = {
      formatVersion: BUNDLE_FORMAT_VERSION,
      name: definition.name,
      description: definition.description,
      exportedAt: new Date().toISOString(),
      agents,
      requirements,
    };

    await writeFile(join(stagingDir, 'bundle.json'), JSON.stringify(manifest, null, 2));

    // Create tar.gz archive
    const archivePath = join(tmpdir(), `${slugify(definition.name)}.autome`);
    await tar.create({ gzip: true, file: archivePath, cwd: stagingDir }, ['.']);

    return { archivePath, manifest, warnings: exportWarnings };
  } finally {
    // Clean up staging directory
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Resource bundling helpers
// ---------------------------------------------------------------------------

/**
 * Bundle file:// or skill:// resources (including globs).
 * Returns the rewritten URI pointing into the bundle.
 */
async function bundleUriResources(
  uri: string,
  scheme: 'file' | 'skill',
  agentId: string,
  specDir: string,
  workDir: string,
  stagingDir: string,
  bundledResources: string[],
): Promise<string> {
  const rawPath = uri.replace(/^(?:file|skill):\/\//, '');
  const origin = classifyPathOrigin(uri);

  // Expand ~ for resolution
  const expandedPath = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;

  // Resolve to absolute for glob/stat
  const basePath = expandedPath.startsWith('/') ? expandedPath : join(specDir, expandedPath);

  // Check if it's a glob pattern
  const isGlob = rawPath.includes('*') || rawPath.includes('?');

  if (isGlob) {
    const matches = await glob(basePath);
    const stripped = stripRootAnchor(rawPath);
    // Find the non-glob prefix to compute relative paths
    const globBase = basePath.slice(0, basePath.indexOf('*'));

    for (const match of matches) {
      const relFromGlobBase = match.slice(globBase.length);
      const globBaseStripped = stripRootAnchor(rawPath.slice(0, rawPath.indexOf('*')));
      const bundlePath = `resources/${agentId}/${scheme}/${origin}/${globBaseStripped}${relFromGlobBase}`;
      const destPath = join(stagingDir, bundlePath);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(match, destPath);
      bundledResources.push(bundlePath);
    }

    // Rewrite the glob URI to point into the bundle
    const rewrittenGlob = `resources/${agentId}/${scheme}/${origin}/${stripped}`;
    return `${scheme}://${rewrittenGlob}`;
  }

  // Single file
  if (!existsSync(basePath)) {
    console.warn(`[export] Resource not found: ${uri} (resolved to ${basePath})`);
    return uri; // Leave as-is if we can't find it
  }

  const stripped = stripRootAnchor(rawPath);
  const bundlePath = `resources/${agentId}/${scheme}/${origin}/${stripped}`;
  const destPath = join(stagingDir, bundlePath);
  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(basePath, destPath);
  bundledResources.push(bundlePath);

  return `${scheme}://${bundlePath}`;
}

/**
 * Bundle a knowledgeBase resource's source directory.
 * Returns the rewritten resource object with autoUpdate=true.
 */
async function bundleKnowledgeBase(
  resource: { type: string; source?: string; name?: string; [key: string]: unknown },
  agentId: string,
  specDir: string,
  workDir: string,
  stagingDir: string,
  bundledResources: string[],
): Promise<{ type: string; source?: string; name?: string; autoUpdate?: boolean; [key: string]: unknown }> {
  const sourcePath = ((resource.source as string | undefined) || '').replace(/^file:\/\//, '');
  const name = (resource.name as string | undefined) || 'unnamed';

  const expandedPath = sourcePath.startsWith('~/')
    ? join(homedir(), sourcePath.slice(2))
    : sourcePath.startsWith('/')
      ? sourcePath
      : join(specDir, sourcePath.startsWith('./') ? sourcePath.slice(2) : sourcePath);

  const bundleDir = `resources/${agentId}/knowledge/${name}`;

  try {
    const srcStat = await stat(expandedPath);
    if (srcStat.isDirectory()) {
      // Recursively copy directory contents
      await copyDir(expandedPath, join(stagingDir, bundleDir));
      bundledResources.push(bundleDir);
    } else {
      // Single file
      const destPath = join(stagingDir, bundleDir, basename(expandedPath));
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(expandedPath, destPath);
      bundledResources.push(`${bundleDir}/${basename(expandedPath)}`);
    }
  } catch {
    console.warn(`[export] Knowledge base source not found: ${sourcePath}`);
    return resource;
  }

  return {
    ...resource,
    source: `file://${bundleDir}`,
    autoUpdate: true,
  };
}

// ---------------------------------------------------------------------------
// Hook command parsing
// ---------------------------------------------------------------------------

/**
 * Parse a hook command string to extract the binary and script path.
 * Handles common patterns: "bash scripts/setup.sh", "node ./validate.js", etc.
 */
function parseHookCommand(command: string): { binary: string | null; scriptPath: string | null } {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return { binary: null, scriptPath: null };

  const binary = parts[0];

  // Look for a file-like argument (has an extension or path separator)
  for (let i = 1; i < parts.length; i++) {
    const arg = parts[i];
    if (arg.startsWith('-')) continue; // Skip flags
    if (arg.includes('/') || arg.includes('.')) {
      return { binary, scriptPath: arg };
    }
  }

  return { binary, scriptPath: null };
}

function classifyScriptOrigin(path: string): PathOrigin {
  if (path.startsWith('~/')) return 'home';
  if (path.startsWith('/')) return 'abs';
  return 'rel';
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function resolveFilePath(path: string, specDir: string, workDir: string): string | null {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path.startsWith('/')) return path;
  // Try relative to spec dir first, then working dir
  const fromSpec = join(specDir, path);
  if (existsSync(fromSpec)) return fromSpec;
  const fromWork = join(workDir, path);
  if (existsSync(fromWork)) return fromWork;
  return null;
}

async function copyDir(src: string, dest: string): Promise<void> {
  const { readdir: rd, stat: st } = await import('fs/promises');
  await mkdir(dest, { recursive: true });
  const entries = await rd(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'workflow'
  );
}
