import type { AcpProvider } from './types.js';
import { KiroProvider } from './kiro.js';
import { OpenCodeProvider } from './opencode.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { GenericProvider, loadProviderConfig } from './generic.js';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

/** Built-in providers */
const BUILTIN_FACTORIES: Record<string, () => AcpProvider> = {
  kiro: () => new KiroProvider(),
  opencode: () => new OpenCodeProvider(),
  'claude-code': () => new ClaudeCodeProvider(),
};

const pluginCache = new Map<string, AcpProvider>();
let pluginsScanned = false;

async function scanPlugins(): Promise<void> {
  if (pluginsScanned) return;
  pluginsScanned = true;

  const dirs = [join(homedir(), '.autome', 'providers'), join(process.cwd(), 'providers')];
  for (const dir of dirs) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const config = await loadProviderConfig(join(dir, file));
          if (!BUILTIN_FACTORIES[config.name] && !pluginCache.has(config.name)) {
            pluginCache.set(config.name, new GenericProvider(config));
            console.log(`[acp] Loaded provider plugin: ${config.name} (${config.displayName}) from ${join(dir, file)}`);
          }
        } catch (err) {
          console.warn(`[acp] Failed to load provider from ${join(dir, file)}:`, err);
        }
      }
    } catch { /* directory doesn't exist */ }
  }
}

/** Create a provider by name (sync — only built-ins and cached plugins) */
export function createProvider(name: string): AcpProvider {
  if (BUILTIN_FACTORIES[name]) return BUILTIN_FACTORIES[name]();
  if (pluginCache.has(name)) return pluginCache.get(name)!;
  throw new Error(
    `Unknown ACP provider: "${name}". Built-in: ${Object.keys(BUILTIN_FACTORIES).join(', ')}. ` +
    `Add custom providers via JSON config in ~/.autome/providers/ or ./providers/.`
  );
}

/** Create a provider, scanning plugin directories first */
export async function createProviderAsync(name: string): Promise<AcpProvider> {
  await scanPlugins();
  return createProvider(name);
}

/** List all available providers */
export async function listProviders(): Promise<Array<{ name: string; displayName: string; source: 'builtin' | 'plugin' }>> {
  await scanPlugins();
  const result: Array<{ name: string; displayName: string; source: 'builtin' | 'plugin' }> = [];
  for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
    const p = factory();
    result.push({ name, displayName: p.displayName, source: 'builtin' });
  }
  for (const [name, provider] of pluginCache) {
    result.push({ name, displayName: provider.displayName, source: 'plugin' });
  }
  return result;
}

/** Reset plugin cache (for testing) */
export function resetPluginCache(): void {
  pluginCache.clear();
  pluginsScanned = false;
}
