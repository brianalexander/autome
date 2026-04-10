/** Shared time-formatting helpers */

/** Convert two ISO timestamps to a human-readable duration string (e.g. "2m 30s") */
export function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Convert seconds to "Xm Ys" or "Xs" format (e.g. "2m 30s", "45s") */
export function formatElapsed(seconds: number): string {
  if (seconds < 0) return '0s';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Strip basic markdown syntax for compact one-line previews. Removes:
 * headings, bold/italic markers, inline code backticks, link syntax, list bullets.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')                  // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')           // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')              // italic
    .replace(/`([^`]+)`/g, '$1')                  // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')      // links
    .replace(/^[-*+]\s+/gm, '')                   // unordered list bullets
    .replace(/^\d+\.\s+/gm, '')                   // ordered list bullets
    .replace(/\s+/g, ' ')                         // collapse whitespace
    .trim();
}

