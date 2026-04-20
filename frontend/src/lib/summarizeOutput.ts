/**
 * Produces a short human-readable preview of a stage output value for display
 * on canvas nodes.
 */
export function summarizeOutput(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 100);
  if (!output || typeof output !== 'object') return String(output).slice(0, 100);
  const o = output as Record<string, unknown>;
  // Check magic keys first
  if (o.summary) return String(o.summary).slice(0, 100);
  if (o.decision) return `Decision: ${o.decision}`;
  if (o.message) return String(o.message).slice(0, 100);
  // Fall back to first string-valued field
  const entries = Object.entries(o);
  if (entries.length === 0) return '';
  const stringEntry = entries.find(([, v]) => typeof v === 'string');
  if (stringEntry) return (stringEntry[1] as string).slice(0, 100);
  // No string fields — stringify the first value
  return JSON.stringify(entries[0][1]).slice(0, 100);
}
