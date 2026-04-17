import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { glob } from 'glob';
import type { LoadedPlugin, PluginManifest, NodeTemplate } from './types.js';
import type { NodeTypeSpec } from '../nodes/types.js';
import { fromProject, PROJECT_ROOT } from '../paths.js';

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  failures: Array<{ path: string; error: Error }>;
}

export async function loadPlugins(): Promise<PluginLoadResult> {
  const loaded: LoadedPlugin[] = [];
  const failures: Array<{ path: string; error: Error }> = [];

  // Determine the project-local plugins directory. AUTOME_PLUGINS_DIR env var overrides.
  const envPluginsDir = process.env.AUTOME_PLUGINS_DIR;
  const localPluginsDir = envPluginsDir
    ? resolve(PROJECT_ROOT, envPluginsDir)
    : fromProject('plugins');

  // 1. Project-local plugins directory
  if (existsSync(localPluginsDir)) {
    const result = await scanPluginsDir(localPluginsDir);
    loaded.push(...result.loaded);
    failures.push(...result.failures);
  }

  // 2. User-global plugins directory (~/.autome/plugins/)
  const globalPluginsDir = join(homedir(), '.autome', 'plugins');
  if (existsSync(globalPluginsDir)) {
    const result = await scanPluginsDir(globalPluginsDir);
    loaded.push(...result.loaded);
    failures.push(...result.failures);
  }

  return { loaded, failures };
}

/**
 * Scan a plugins directory for:
 * 1. Subdirectories with autome-plugin.json (manifest-driven)
 * 2. Loose .ts/.js files (legacy single-file fallback)
 */
async function scanPluginsDir(pluginsDir: string): Promise<PluginLoadResult> {
  const loaded: LoadedPlugin[] = [];
  const failures: Array<{ path: string; error: Error }> = [];

  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch (err) {
    console.warn(`[plugins] Failed to read ${pluginsDir}:`, err);
    return { loaded, failures };
  }

  for (const entry of entries.sort()) {
    const entryPath = join(pluginsDir, entry);

    // Check if this entry is a subdirectory with a manifest
    const manifestPath = join(entryPath, 'autome-plugin.json');
    if (existsSync(manifestPath)) {
      const result = await loadManifestPlugin(entryPath, manifestPath);
      if (result.plugin) {
        loaded.push(result.plugin);
      }
      failures.push(...result.failures);
      continue;
    }

    // Legacy fallback: loose .ts or .js files directly in the plugins dir
    if (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')) {
      const result = await loadLegacyFile(entryPath);
      if (result.plugin) {
        loaded.push(result.plugin);
      } else if (result.error) {
        failures.push({ path: entryPath, error: result.error });
      }
    }
  }

  return { loaded, failures };
}

/**
 * Load a manifest-driven plugin from a directory.
 */
async function loadManifestPlugin(
  pluginDir: string,
  manifestPath: string,
): Promise<{ plugin?: LoadedPlugin; failures: Array<{ path: string; error: Error }> }> {
  const failures: Array<{ path: string; error: Error }> = [];

  // Parse manifest
  let manifest: PluginManifest;
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as PluginManifest;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[plugins] Failed to parse ${manifestPath}:`, error);
    return { failures: [{ path: manifestPath, error }] };
  }

  // Validate required fields
  if (!manifest.id || typeof manifest.id !== 'string') {
    const error = new Error('Manifest missing required field: id');
    return { failures: [{ path: manifestPath, error }] };
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    const error = new Error('Manifest missing required field: name');
    return { failures: [{ path: manifestPath, error }] };
  }

  // Load node types
  const nodeTypes: NodeTypeSpec[] = [];
  if (manifest.nodeTypes?.length) {
    for (const relPath of manifest.nodeTypes) {
      const absPath = resolve(pluginDir, relPath);
      try {
        const mod = await import(absPath);
        const spec = mod.default;
        if (!spec || typeof spec !== 'object' || !('id' in spec)) {
          failures.push({
            path: absPath,
            error: new Error(`Node type file does not default-export a NodeTypeSpec (missing 'id')`),
          });
        } else {
          nodeTypes.push(spec as NodeTypeSpec);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        failures.push({ path: absPath, error });
      }
    }

    // If any node type failed to load, fail the entire plugin (partial loads are confusing)
    if (failures.length > 0) {
      return { failures };
    }
  }

  // Load templates
  const templates: NodeTemplate[] = [];
  if (manifest.templates?.length) {
    for (const pattern of manifest.templates) {
      const matchedFiles = await glob(pattern, { cwd: pluginDir, absolute: false });
      for (const relFile of matchedFiles.sort()) {
        const absFile = resolve(pluginDir, relFile);
        try {
          const raw = await readFile(absFile, 'utf-8');
          const parsed = JSON.parse(raw) as NodeTemplate | NodeTemplate[];
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const tpl of list) {
            if (!tpl || typeof tpl !== 'object' || !('id' in tpl)) {
              console.warn(`[plugins] Skipping invalid template entry in ${absFile}`);
              continue;
            }
            templates.push(tpl);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          failures.push({ path: absFile, error });
        }
      }

      if (failures.length > 0) {
        return { failures };
      }
    }
  }

  const plugin: LoadedPlugin = {
    manifest,
    dir: pluginDir,
    nodeTypes,
    templates,
  };

  console.log(
    `[plugins] Loaded "${manifest.name}"${manifest.version ? ` v${manifest.version}` : ''} ` +
    `(${nodeTypes.length} node type(s), ${templates.length} template(s))`,
  );

  return { plugin, failures };
}

/**
 * Legacy fallback: a loose .ts/.js file that default-exports an object with at least a `name` field.
 */
async function loadLegacyFile(
  filePath: string,
): Promise<{ plugin?: LoadedPlugin; error?: Error }> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;

    if (!exported || typeof exported !== 'object' || !('name' in exported)) {
      console.warn(`[plugins] Skipping ${filePath}: does not default-export an object with a 'name' field`);
      return {};
    }

    const legacy = exported as { name: string; version?: string; nodeTypes?: NodeTypeSpec[]; templates?: NodeTemplate[] };

    const manifest: PluginManifest = {
      id: legacy.name,
      name: legacy.name,
      version: legacy.version,
    };

    const plugin: LoadedPlugin = {
      manifest,
      dir: filePath,
      nodeTypes: legacy.nodeTypes ?? [],
      templates: legacy.templates ?? [],
    };

    console.log(`[plugins] Loaded legacy plugin "${manifest.name}" from ${filePath}`);
    return { plugin };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[plugins] Failed to import ${filePath}:`, error);
    return { error };
  }
}
