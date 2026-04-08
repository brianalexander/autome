/**
 * Convert a human-readable label to a valid stage ID (snake_case).
 * Examples: "Security Review" → "security_review", "Code Gen" → "code_gen"
 * Only allows [a-z][a-z0-9_]* — strips everything else.
 */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_]/g, '')  // remove non-alphanumeric (keep spaces and underscores)
    .replace(/\s+/g, '_')           // spaces → underscores
    .replace(/_+/g, '_')            // collapse multiple underscores
    .replace(/^_|_$/g, '');         // trim leading/trailing underscores
}
