import 'dotenv/config';
import { loadConfig } from './config/loader.js';
import { startServer } from './server-start.js';

/**
 * Direct server entry point (used by `npm run dev`).
 * Loads config from env/config-file then starts the server.
 */
loadConfig()
  .then((resolvedConfig) => startServer(resolvedConfig))
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
