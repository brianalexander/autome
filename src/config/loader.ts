import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import type { AutomeConfig, ResolvedConfig } from './types.js';

/**
 * Load and resolve configuration from (highest precedence first):
 * 1. `overrides` argument (CLI args)
 * 2. Environment variables
 * 3. Config file (autome.config.{ts,js,json} in cwd)
 * 4. Built-in defaults
 */
export async function loadConfig(overrides?: Partial<AutomeConfig>): Promise<ResolvedConfig> {
  const fileConfig = await loadConfigFile();
  const envConfig = readEnvConfig();

  // Merge: overrides > env > file > defaults
  const merged: AutomeConfig = {
    ...fileConfig,
    ...envConfig,
    ...overrides,
  };

  // Resolve dataDir to absolute path
  const dataDir = resolve(process.cwd(), merged.dataDir ?? './data');

  // Derive paths from dataDir unless explicitly set
  const databasePath = resolve(
    process.cwd(),
    merged.databasePath ?? join(dataDir, 'orchestrator.db'),
  );
  const workspacesDir = resolve(
    process.cwd(),
    merged.workspacesDir ?? join(dataDir, 'workspaces'),
  );

  // Resolve mode
  let mode: 'dev' | 'production';
  const rawMode = merged.mode ?? 'auto';
  if (rawMode === 'auto') {
    mode = process.env.NODE_ENV === 'production' ? 'production' : 'dev';
  } else {
    mode = rawMode;
  }

  const plugins = (merged.plugins ?? []).map((p) => resolve(process.cwd(), p));

  return {
    port: merged.port ?? 3001,
    host: merged.host ?? '127.0.0.1',
    dataDir,
    databasePath,
    workspacesDir,
    acpProvider: merged.acpProvider ?? undefined,
    mode,
    openBrowser: merged.openBrowser ?? false,
    plugins,
  };
}

function readEnvConfig(): Partial<AutomeConfig> {
  const cfg: Partial<AutomeConfig> = {};

  if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed)) cfg.port = parsed;
  }
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;
  if (process.env.DATABASE_PATH) cfg.databasePath = process.env.DATABASE_PATH;
  if (process.env.ACP_PROVIDER) cfg.acpProvider = process.env.ACP_PROVIDER;
  if (process.env.NODE_ENV === 'production') cfg.mode = 'production';

  return cfg;
}

async function loadConfigFile(): Promise<AutomeConfig> {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'autome.config.ts'),
    join(cwd, 'autome.config.js'),
    join(cwd, 'autome.config.json'),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      if (filePath.endsWith('.json')) {
        const { readFileSync } = await import('node:fs');
        return JSON.parse(readFileSync(filePath, 'utf-8')) as AutomeConfig;
      }
      // .ts or .js — use tsImport so consumer package.json#type is irrelevant.
      // When the consumer package is CJS, tsImport wraps the ES `export default`
      // as module.exports.default, causing mod.default = { default: actualValue }.
      // Unwrap that extra layer when present.
      const mod = await tsImport(filePath, import.meta.url);
      let cfg = mod.default ?? mod;
      if (cfg && typeof cfg === 'object' && 'default' in cfg) {
        cfg = (cfg as Record<string, unknown>).default ?? cfg;
      }
      return (typeof cfg === 'function' ? cfg() : cfg) as AutomeConfig;
    } catch (err) {
      console.warn(`[config] Failed to load ${filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  return {};
}
