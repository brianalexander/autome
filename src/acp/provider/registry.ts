import type { AcpProvider } from './types.js';
import { KiroProvider } from './kiro.js';
import { OpenCodeProvider } from './opencode.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { discoverCustomProviders } from './loader.js';

/** Built-in providers */
const BUILTIN_FACTORIES: Record<string, () => AcpProvider> = {
  kiro: () => new KiroProvider(),
  opencode: () => new OpenCodeProvider(),
  'claude-code': () => new ClaudeCodeProvider(),
};

/** Custom providers discovered at startup — keyed by name for O(1) lookup */
const customProviders = new Map<string, AcpProvider>();

/**
 * Discover custom providers from the filesystem and register them.
 * Custom providers with the same name as a built-in override the built-in.
 * Safe to call multiple times — re-runs discovery each call (cache lives in loader).
 */
export async function initializeProviders(dirs?: string[]): Promise<void> {
  const discovered = await discoverCustomProviders(dirs);
  for (const provider of discovered) {
    customProviders.set(provider.name, provider);
  }
  if (discovered.length > 0) {
    console.log(`[providers] Discovered ${discovered.length} custom provider(s): ${discovered.map((p) => p.name).join(', ')}`);
  } else {
    console.log('[providers] No custom providers found');
  }
}

/** Create a provider by name — checks custom providers first, then built-ins */
export function createProvider(name: string): AcpProvider {
  const custom = customProviders.get(name);
  if (custom) return custom;
  if (BUILTIN_FACTORIES[name]) return BUILTIN_FACTORIES[name]();
  const allNames = [...customProviders.keys(), ...Object.keys(BUILTIN_FACTORIES)];
  throw new Error(
    `Unknown ACP provider: "${name}". Available providers: ${allNames.join(', ')}.`,
  );
}

/** List all available providers — custom providers appear first, then built-ins */
export function listProviders(): Array<{ name: string; displayName: string; source: 'builtin' | 'custom' }> {
  const results: Array<{ name: string; displayName: string; source: 'builtin' | 'custom' }> = [];

  // Custom providers first (they may shadow built-ins)
  for (const [name, provider] of customProviders) {
    results.push({ name, displayName: provider.displayName, source: 'custom' });
  }

  // Built-ins, skipping any that are shadowed by a custom provider
  for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
    if (customProviders.has(name)) continue;
    const p = factory();
    results.push({ name, displayName: p.displayName, source: 'builtin' });
  }

  return results;
}
