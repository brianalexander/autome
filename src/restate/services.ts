import * as restate from '@restatedev/restate-sdk';
import { initializeRegistry, nodeRegistry } from '../nodes/registry.js';
import { pipelineWorkflow } from './pipeline-workflow.js';
import { loadPlugins } from '../plugin/loader.js';
import { applyPluginNodeTypes } from '../plugin/apply.js';

// Initialize node registry before binding the workflow endpoint
await initializeRegistry();

// Load plugins and register their node types into the registry
const plugins = await loadPlugins();
await applyPluginNodeTypes(plugins, nodeRegistry);

const endpoint = restate.endpoint();
endpoint.bind(pipelineWorkflow);

const port = parseInt(process.env.RESTATE_SERVICE_PORT || '9080', 10);
endpoint.listen(port);
console.log(`Restate services listening on port ${port}`);

/**
 * Auto-register this deployment with the Restate server.
 * Retries a few times since the Restate server may still be starting.
 */
async function autoRegister() {
  const restateAdminUrl = process.env.RESTATE_ADMIN_URL || 'http://localhost:9070';
  const serviceUrl = `http://localhost:${port}`;
  const maxRetries = 10;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${restateAdminUrl}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: serviceUrl, force: true }),
      });
      if (res.ok) {
        const data = await res.json() as { id?: string; services?: Array<{ name: string; revision: number }> };
        const services = data.services?.map((s) => s.name).join(', ') || 'unknown';
        console.log(`Restate auto-registered deployment (${services}) on attempt ${attempt}`);
        return;
      }
      const errorText = await res.text();
      console.warn(`Restate registration attempt ${attempt}/${maxRetries} failed (${res.status}): ${errorText}`);
    } catch (err) {
      console.warn(`Restate registration attempt ${attempt}/${maxRetries} failed: ${err instanceof Error ? err.message : err}`);
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  console.error('Failed to auto-register with Restate server after all retries. Run manually: npm run restate:register');
}

autoRegister();
