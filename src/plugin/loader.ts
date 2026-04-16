import { existsSync } from 'fs';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { homedir } from 'os';
import type { AutomePlugin } from './types.js';

export async function loadPlugins(): Promise<AutomePlugin[]> {
  const plugins: AutomePlugin[] = [];

  // 1. AUTOME_PLUGINS env var (highest priority)
  const envPath = process.env.AUTOME_PLUGINS;
  if (envPath) {
    const resolved = join(process.cwd(), envPath);
    if (existsSync(resolved)) {
      const loaded = await loadPluginFile(resolved);
      plugins.push(...loaded);
    } else {
      console.warn(`[plugins] AUTOME_PLUGINS path not found: ${resolved}`);
    }
  }

  // 2. autome.plugins.ts / autome.plugins.js in cwd
  if (!envPath) {
    for (const filename of ['autome.plugins.ts', 'autome.plugins.js']) {
      const configPath = join(process.cwd(), filename);
      if (existsSync(configPath)) {
        const loaded = await loadPluginFile(configPath);
        plugins.push(...loaded);
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
          try {
            const loaded = await loadPluginFile(filePath);
            plugins.push(...loaded);
          } catch (err) {
            console.warn(`[plugins] Failed to load ${filePath}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn(`[plugins] Failed to read ${globalPluginsDir}:`, err);
    }
  }

  return plugins;
}

async function loadPluginFile(filePath: string): Promise<AutomePlugin[]> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;
    const list = Array.isArray(exported) ? exported : [exported];
    // Validate each has a name
    return list.filter((p: unknown) => {
      if (!p || typeof p !== 'object' || !('name' in p)) {
        console.warn(`[plugins] Skipping invalid plugin export from ${filePath}`);
        return false;
      }
      return true;
    });
  } catch (err) {
    console.error(`[plugins] Failed to import ${filePath}:`, err);
    return [];
  }
}
