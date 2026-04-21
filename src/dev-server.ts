import 'dotenv/config';
import { loadConfig } from './config/loader.js';
import { startServer } from './server-start.js';

/**
 * Development entry point — loads config from env/config-file then starts the server.
 * Used by `npm run dev` via `tsx watch src/dev-server.ts`.
 * Not part of the public API — use `startServer` from 'autome' for programmatic use.
 */
loadConfig()
  .then((resolvedConfig) => startServer(resolvedConfig))
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
