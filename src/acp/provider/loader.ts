/**
 * Custom Provider Loader — discovers and loads third-party ACP providers from:
 *   - ./providers/          (project-local custom providers)
 *   - ~/.autome/providers/  (user-global custom providers)
 *
 * Providers must be .ts, .js, or .mjs files that default-export an AcpProvider
 * (or a class that extends BaseProvider). Individual failures are logged and
 * skipped; the loader never crashes the process.
 */
import { readdir } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { AcpProvider } from './types.js';

/** Paths where custom providers are discovered */
export const CUSTOM_PROVIDER_DIRS = [
  join(process.cwd(), 'providers'),
  join(homedir(), '.autome', 'providers'),
];

/**
 * Discover and load all custom ACP providers from configured directories.
 *
 * Accepts an optional `dirs` parameter for testing — when omitted, uses CUSTOM_PROVIDER_DIRS.
 * Returns an array of valid AcpProviders. Invalid exports are logged and skipped.
 */
export async function discoverCustomProviders(dirs?: string[]): Promise<AcpProvider[]> {
  const searchDirs = dirs ?? CUSTOM_PROVIDER_DIRS;
  const providers: AcpProvider[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const ext = extname(entry).toLowerCase();
        if (!['.ts', '.js', '.mjs'].includes(ext)) continue;

        const fullPath = join(dir, entry);
        try {
          const provider = await loadProviderModule(fullPath);
          if (provider) {
            providers.push(provider);
            console.log(`[custom-providers] Loaded custom provider "${provider.name}" from ${fullPath}`);
          }
        } catch (err) {
          console.warn(`[custom-providers] Failed to load ${entry}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[custom-providers] Cannot read directory ${dir}:`, err);
    }
  }

  return providers;
}

async function loadProviderModule(path: string): Promise<AcpProvider | null> {
  // Dynamic import — for .ts files, requires tsx or ts-node in the loader chain
  const mod = await import(path);
  const Export = mod.default ?? mod;

  if (!Export || (typeof Export !== 'object' && typeof Export !== 'function')) {
    console.warn(`[custom-providers] Module at ${path} does not export an object or class`);
    return null;
  }

  // If it's a class (has a prototype with methods beyond Object.prototype), instantiate it
  const provider: unknown =
    typeof Export === 'function' ? new (Export as new () => unknown)() : Export;

  if (!isValidProvider(provider)) {
    console.warn(
      `[custom-providers] Module at ${path} is missing required fields: name (string), getCommand(), getSpawnArgs()`,
    );
    return null;
  }

  return provider;
}

function isValidProvider(candidate: unknown): candidate is AcpProvider {
  if (!candidate || typeof candidate !== 'object') return false;
  const p = candidate as Record<string, unknown>;
  return (
    typeof p['name'] === 'string' &&
    p['name'].length > 0 &&
    typeof p['getCommand'] === 'function' &&
    typeof p['getSpawnArgs'] === 'function'
  );
}

// ---------------------------------------------------------------------------
// Cached variant — avoids re-scanning on every call in production
// ---------------------------------------------------------------------------

let _cachedProviders: AcpProvider[] | null = null;

/**
 * Like discoverCustomProviders() but caches results across calls.
 * Use resetCustomProviderCache() in tests to clear between runs.
 */
export async function discoverCustomProvidersCached(): Promise<AcpProvider[]> {
  if (!_cachedProviders) {
    _cachedProviders = await discoverCustomProviders();
  }
  return _cachedProviders;
}

/** Clear the cache — primarily for testing. */
export function resetCustomProviderCache(): void {
  _cachedProviders = null;
}
