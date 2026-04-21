/**
 * Package main — programmatic API surface.
 * Import this to embed autome in another application.
 *
 * @example
 * import { startServer, loadConfig } from 'autome';
 * const config = await loadConfig({ port: 9999 });
 * await startServer(config, { plugins: [myPlugin] });
 */
export { startServer } from './server-start.js';
export { loadConfig } from './config/loader.js';
export type { AutomeConfig, ResolvedConfig } from './config/types.js';
