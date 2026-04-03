import * as LucideIcons from 'lucide-react';
import type { ComponentType } from 'react';

/** Convert kebab-case to PascalCase (e.g. 'shield-check' -> 'ShieldCheck') */
function toPascalCase(str: string): string {
  return str.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** Resolve a Lucide icon name to a component. Returns null if not found. */
export function resolveLucideIcon(
  name: string,
): ComponentType<{ className?: string; strokeWidth?: number }> | null {
  const pascalName = toPascalCase(name);
  const Icon = (LucideIcons as Record<string, unknown>)[pascalName] as
    | ComponentType<{ className?: string; strokeWidth?: number }>
    | undefined;
  return Icon ?? null;
}
