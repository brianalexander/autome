import type { AcpProvider } from './types.js';
import { KiroProvider } from './kiro.js';
import { OpenCodeProvider } from './opencode.js';
import { ClaudeCodeProvider } from './claude-code.js';

/** Built-in providers */
const BUILTIN_FACTORIES: Record<string, () => AcpProvider> = {
  kiro: () => new KiroProvider(),
  opencode: () => new OpenCodeProvider(),
  'claude-code': () => new ClaudeCodeProvider(),
};

/**
 * Create a provider by name from the built-in set.
 * Custom/programmatic providers are registered via the `providers` option to `startServer()`
 * and resolved in server-start.ts before this function is called.
 */
export function createProvider(name: string): AcpProvider {
  if (BUILTIN_FACTORIES[name]) return BUILTIN_FACTORIES[name]();
  throw new Error(
    `Unknown ACP provider: "${name}". Built-in providers: ${Object.keys(BUILTIN_FACTORIES).join(', ')}. ` +
    'Custom providers must be passed via the `providers` option to startServer().',
  );
}

/**
 * List available providers.
 *
 * Built-in providers are always included.  Pass `extra` (the programmatic
 * providers map from startServer options) to merge custom providers into the
 * result.  When a name appears in both built-ins and `extra`, the entry in
 * `extra` wins (override semantics match the runtime resolver in server-start.ts).
 */
export function listProviders(
  extra?: Map<string, AcpProvider>,
): Array<{ name: string; displayName: string; source: 'builtin' | 'custom' }> {
  const results: Array<{ name: string; displayName: string; source: 'builtin' | 'custom' }> = [];

  // Start with built-ins, skipping any that are overridden by a custom provider.
  for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
    if (extra?.has(name)) continue; // custom wins
    const p = factory();
    results.push({ name, displayName: p.displayName, source: 'builtin' });
  }

  // Append custom (programmatic) providers.
  if (extra) {
    for (const [name, provider] of extra) {
      results.push({ name, displayName: provider.displayName, source: 'custom' });
    }
  }

  return results;
}
