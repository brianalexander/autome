/**
 * Custom Node Loader — discovers and loads third-party node specs from two locations:
 *   - ./nodes/          (project-local custom nodes)
 *   - ~/.autome/nodes/  (user-global custom nodes)
 *
 * Two formats are supported:
 *   - JSON manifests (.json): declarative, get a passthrough executor auto-generated
 *   - JS/TS modules (.ts, .js, .mjs): must default-export a NodeTypeSpec with executor
 *
 * Follows the same resilience pattern as the ACP provider plugin loader in src/acp/provider.ts:
 * individual failures are logged and skipped; the loader never crashes the process.
 */
import { readdir, readFile } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { NodeTypeSpec } from '../types.js';
import { fromProject } from '../../paths.js';

/** Paths where custom nodes are discovered */
export const CUSTOM_NODE_DIRS = [
  fromProject('nodes'),
  join(homedir(), '.autome', 'nodes'),
];

/** JSON manifest for declarative custom nodes (no executor code required) */
export interface CustomNodeManifest {
  id: string;
  name: string;
  category: 'trigger' | 'step';
  description: string;
  icon?: string;
  color?: { bg: string; border: string; text: string };
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  inEdgeSchema?: Record<string, unknown>;
  outEdgeSchema?: Record<string, unknown>;
}

/**
 * Discover and load all custom node specs from configured directories.
 *
 * Accepts an optional `dirs` parameter for testing — when omitted, uses CUSTOM_NODE_DIRS.
 * Returns an array of valid NodeTypeSpecs. Invalid specs are logged and skipped.
 */
export async function discoverCustomNodes(dirs?: string[]): Promise<NodeTypeSpec[]> {
  const searchDirs = dirs ?? CUSTOM_NODE_DIRS;
  const specs: NodeTypeSpec[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const ext = extname(entry).toLowerCase();
        const fullPath = join(dir, entry);

        try {
          let spec: NodeTypeSpec | null = null;

          if (ext === '.json') {
            spec = await loadJsonSpec(fullPath);
          } else if (['.ts', '.js', '.mjs'].includes(ext)) {
            spec = await loadModuleSpec(fullPath);
          }

          if (spec) {
            // Validate minimum required fields
            if (!spec.id || !spec.name || !spec.category || !spec.executor) {
              console.warn(
                `[custom-nodes] Skipping ${entry}: missing required fields (id, name, category, executor)`,
              );
              continue;
            }
            specs.push(spec);
            console.log(`[custom-nodes] Loaded custom node "${spec.id}" from ${fullPath}`);
          }
        } catch (err) {
          console.warn(`[custom-nodes] Failed to load ${entry}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[custom-nodes] Cannot read directory ${dir}:`, err);
    }
  }

  return specs;
}

async function loadJsonSpec(path: string): Promise<NodeTypeSpec | null> {
  const raw = await readFile(path, 'utf-8');
  const manifest = JSON.parse(raw) as CustomNodeManifest;

  // Validate required fields
  if (!manifest.id || !manifest.name || !manifest.category) {
    console.warn(`[custom-nodes] JSON spec at ${path} missing id, name, or category`);
    return null;
  }

  // Build a NodeTypeSpec with a passthrough executor
  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description || '',
    icon: manifest.icon || '🧩',
    color: manifest.color || { bg: '#f3f4f6', border: '#9ca3af', text: '#6b7280' },
    configSchema: manifest.configSchema || { type: 'object', properties: {} },
    defaultConfig: manifest.defaultConfig || {},
    inEdgeSchema: manifest.inEdgeSchema,
    outEdgeSchema: manifest.outEdgeSchema,
    executor:
      manifest.category === 'trigger'
        ? { type: 'trigger' as const }
        : {
            type: 'step' as const,
            async execute(execCtx) {
              // Passthrough: return the input's source output unchanged
              return { output: execCtx.input?.sourceOutput ?? {} };
            },
          },
  };
}

async function loadModuleSpec(path: string): Promise<NodeTypeSpec | null> {
  // Dynamic import — for .ts files, requires tsx or ts-node in the loader chain
  const mod = await import(path);
  const spec = mod.default ?? mod;

  if (!spec || typeof spec !== 'object' || !('id' in spec)) {
    console.warn(`[custom-nodes] Module at ${path} does not export a valid NodeTypeSpec`);
    return null;
  }

  return spec as NodeTypeSpec;
}

// ---------------------------------------------------------------------------
// Cached variant — avoids re-scanning on every call in production
// ---------------------------------------------------------------------------

let _cachedSpecs: NodeTypeSpec[] | null = null;

/**
 * Like discoverCustomNodes() but caches results across calls.
 * Use resetCustomNodeCache() in tests to clear between runs.
 */
export async function discoverCustomNodesCached(): Promise<NodeTypeSpec[]> {
  if (!_cachedSpecs) {
    _cachedSpecs = await discoverCustomNodes();
  }
  return _cachedSpecs;
}

/** Clear the cache — primarily for testing. */
export function resetCustomNodeCache(): void {
  _cachedSpecs = null;
}
