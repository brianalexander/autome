/**
 * Formats a run input/output value for display in a monospace block.
 * Strings are returned as-is; everything else is pretty-printed as JSON.
 */
export function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
