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

/** Create a provider by name (built-ins only) */
export function createProvider(name: string): AcpProvider {
  if (BUILTIN_FACTORIES[name]) return BUILTIN_FACTORIES[name]();
  throw new Error(
    `Unknown ACP provider: "${name}". Built-in providers: ${Object.keys(BUILTIN_FACTORIES).join(', ')}.`,
  );
}

/** List all available built-in providers */
export function listProviders(): Array<{ name: string; displayName: string; source: 'builtin' }> {
  return Object.entries(BUILTIN_FACTORIES).map(([name, factory]) => {
    const p = factory();
    return { name, displayName: p.displayName, source: 'builtin' as const };
  });
}
