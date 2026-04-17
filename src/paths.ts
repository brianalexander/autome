/**
 * Central path resolver for the autome package.
 *
 * Provides the package root directory (where autome's own files live)
 * and the project root directory (the user's cwd where data/ and plugins/ live).
 *
 * These are the same when running from the autome source repo, but different
 * when autome is installed as a dependency in another project.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Root of the autome package — where dist/, agents/, src/, frontend/ live.
 * When running from source (tsx): __dirname is src/, go up 1
 * When running compiled (dist/): __dirname is dist/, go up 1
 */
export const PACKAGE_ROOT = join(__dirname, '..');

/**
 * Root of the user's project — where data/, plugins/, autome.config.ts live.
 * Always process.cwd().
 */
export const PROJECT_ROOT = process.cwd();

/** Resolve a path relative to the autome package root */
export function fromPackage(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments);
}

/** Resolve a path relative to the user's project root */
export function fromProject(...segments: string[]): string {
  return join(PROJECT_ROOT, ...segments);
}
