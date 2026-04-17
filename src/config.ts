/**
 * Centralized configuration — all ports, URLs, and env-derived settings live here.
 * Import `config` instead of reading process.env / hardcoding values in each file.
 *
 * NOTE: This module exports a synchronously-initialized `config` object for
 * backwards compatibility. The full resolved config (including config-file support)
 * is available via `loadConfig()` from `./config/loader.js`.
 */

export { loadConfig } from './config/loader.js';
export { defineConfig } from './config/types.js';
export type { AutomeConfig, ResolvedConfig } from './config/types.js';

/** The default ACP provider name when no DB setting or env var is configured. */
export const DEFAULT_ACP_PROVIDER = 'kiro';

export const config: {
  port: number;
  orchestratorUrl: string;
  /** ACP provider env-var fallback. undefined means "not configured via env". */
  acpProvider: string | undefined;
} = {
  port: parseInt(process.env.PORT || '3001', 10),
  orchestratorUrl: process.env.ORCHESTRATOR_URL || `http://localhost:${process.env.PORT || '3001'}`,
  acpProvider: process.env.ACP_PROVIDER || undefined,
};
