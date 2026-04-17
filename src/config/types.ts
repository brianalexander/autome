export interface AutomeConfig {
  /** Port the server listens on. Default: 3001 */
  port?: number;

  /** Host/interface to bind to. Default: '127.0.0.1' (localhost only).
   *  Use '0.0.0.0' to expose on LAN. */
  host?: string;

  /** Root data directory — holds DB, workspaces, agent configs, etc.
   *  Default: './data' */
  dataDir?: string;

  /** Individual path overrides (all default to subpaths of dataDir). */
  databasePath?: string;
  workspacesDir?: string;

  /** Default ACP provider. Can be overridden per-workflow. */
  acpProvider?: 'claude-code' | 'opencode' | 'kiro' | (string & {});

  /** Plugin files to load in order. Paths are resolved relative to cwd.
   *  In addition to any autome.plugins.ts auto-discovered. */
  plugins?: string[];

  /** Mode: 'dev' uses dev defaults (CORS open, etc.), 'production' uses
   *  production defaults (bundled frontend, stricter CORS). Default: 'auto'
   *  (based on NODE_ENV). */
  mode?: 'dev' | 'production' | 'auto';

  /** Auto-open the browser on startup. Default: false (only true when CLI says so). */
  openBrowser?: boolean;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  workspacesDir: string;
  acpProvider: string | undefined;
  plugins: string[];
  mode: 'dev' | 'production';
  openBrowser: boolean;
}

export function defineConfig(config: AutomeConfig): AutomeConfig {
  return config;
}
