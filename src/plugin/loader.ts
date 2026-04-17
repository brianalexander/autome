import { existsSync } from 'fs';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import type { AutomePlugin } from './types.js';

export interface PluginLoadResult {
  loaded: AutomePlugin[];
  failures: Array<{ path: string; error: Error }>;
}

export async function loadPlugins(): Promise<PluginLoadResult> {
  const loaded: AutomePlugin[] = [];
  const failures: Array<{ path: string; error: Error }> = [];

  // 1. AUTOME_PLUGINS env var (highest priority)
  const envPath = process.env.AUTOME_PLUGINS;
  if (envPath) {
    const resolved = join(process.cwd(), envPath);
    if (existsSync(resolved)) {
      const result = await loadPluginFile(resolved);
      loaded.push(...result.plugins);
      failures.push(...result.failures);
    } else {
      console.warn(`[plugins] AUTOME_PLUGINS path not found: ${resolved}`);
    }
  }

  // 2. autome.plugins.ts / autome.plugins.js in cwd
  if (!envPath) {
    for (const filename of ['autome.plugins.ts', 'autome.plugins.js']) {
      const configPath = join(process.cwd(), filename);
      if (existsSync(configPath)) {
        const result = await loadPluginFile(configPath);
        loaded.push(...result.plugins);
        failures.push(...result.failures);
        break; // only load first found
      }
    }
  }

  // 3. ~/.autome/plugins/ directory
  const globalPluginsDir = join(homedir(), '.autome', 'plugins');
  if (existsSync(globalPluginsDir)) {
    try {
      const entries = await readdir(globalPluginsDir);
      for (const entry of entries.sort()) {
        if (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')) {
          const filePath = join(globalPluginsDir, entry);
          const result = await loadPluginFile(filePath);
          loaded.push(...result.plugins);
          failures.push(...result.failures);
        }
      }
    } catch (err) {
      console.warn(`[plugins] Failed to read ${globalPluginsDir}:`, err);
    }
  }

  return { loaded, failures };
}

async function loadPluginFile(
  filePath: string,
): Promise<{ plugins: AutomePlugin[]; failures: Array<{ path: string; error: Error }> }> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;
    const list = Array.isArray(exported) ? exported : [exported];
    // Validate each has a name
    const plugins = list.filter((p: unknown) => {
      if (!p || typeof p !== 'object' || !('name' in p)) {
        console.warn(`[plugins] Skipping invalid plugin export from ${filePath}`);
        return false;
      }
      return true;
    });
    return { plugins, failures: [] };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[plugins] Failed to import ${filePath}:`, error);
    return { plugins: [], failures: [{ path: filePath, error }] };
  }
}
