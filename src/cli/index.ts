#!/usr/bin/env node
/**
 * Default autome CLI entry point.
 * Delegates to createCli with the 'autome' branding.
 *
 * Third-party wrappers should import createCli from 'autome/cli' instead:
 *
 *   import { createCli } from 'autome/cli';
 *   await createCli({ name: 'my-product', version: '1.0.0' }).run(process.argv);
 */
import { createCli } from './create.js';

createCli({ name: 'autome', version: '0.1.0' }).run(process.argv).catch((err) => {
  console.error('[autome] Fatal error:', err);
  process.exit(1);
});
