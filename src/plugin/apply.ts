import type { AutomePlugin } from './types.js';
import type { NodeTypeRegistry } from '../nodes/registry.js';
import type { EventBus } from '../events/bus.js';
import type { OrchestratorDB } from '../db/database.js';

const CURRENT_API_VERSION = 1;

// Track loaded plugins for shutdown hooks
const loadedPlugins: AutomePlugin[] = [];

/** Apply only node-type registrations (for the Restate service process which has no Fastify) */
export async function applyPluginNodeTypes(plugins: AutomePlugin[], nodeRegistry: NodeTypeRegistry): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.apiVersion && plugin.apiVersion > CURRENT_API_VERSION) continue;
    if (plugin.nodeTypes?.length) {
      for (const spec of plugin.nodeTypes) {
        nodeRegistry.register(spec);
      }
      console.log(`[plugins] Registered ${plugin.nodeTypes.length} node type(s) from "${plugin.name}"`);
    }
  }
}

/** Call onClose hooks for all loaded plugins (called during graceful shutdown) */
export async function shutdownPlugins(): Promise<void> {
  for (const plugin of loadedPlugins) {
    if (plugin.onClose) {
      try {
        await plugin.onClose();
      } catch (err) {
        console.warn(`[plugins] Error during shutdown of "${plugin.name}":`, err);
      }
    }
  }
}

/**
 * Sync plugin-defined templates into the database.
 * - Creates the template if it doesn't exist yet.
 * - Updates it if the existing record came from the same plugin source.
 * - Skips it if another source owns the record (avoids stomping user edits).
 */
export async function syncPluginTemplates(plugins: AutomePlugin[], db: OrchestratorDB): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.apiVersion && plugin.apiVersion > CURRENT_API_VERSION) continue;
    if (!plugin.templates?.length) continue;

    const source = `plugin:${plugin.name}`;
    for (const tpl of plugin.templates) {
      try {
        const existing = db.getNodeTemplate(tpl.id);
        if (!existing) {
          db.createNodeTemplate({ ...tpl, source });
          console.log(`[plugins] Registered template: ${tpl.name} (${tpl.id})`);
        } else if (existing.source === source) {
          // Only update if something actually changed
          const hasChanges =
            existing.name !== tpl.name ||
            existing.description !== (tpl.description ?? null) ||
            existing.node_type !== tpl.nodeType ||
            existing.icon !== (tpl.icon ?? null) ||
            existing.category !== (tpl.category ?? null) ||
            JSON.stringify(existing.config) !== JSON.stringify(tpl.config) ||
            JSON.stringify(existing.exposed) !== JSON.stringify(tpl.exposed ?? []) ||
            JSON.stringify(existing.locked) !== JSON.stringify(tpl.locked ?? []);
          if (hasChanges) {
            db.updateNodeTemplate(tpl.id, { ...tpl, source });
            console.log(`[plugins]   Updated template: ${tpl.name} (${tpl.id})`);
          }
        }
        // else: owned by a different source, leave it alone
      } catch (err) {
        console.warn(`[plugins] Failed to sync template ${tpl.id}:`, err);
      }
    }
  }
}

/**
 * Track a plugin as loaded so its onClose hook is called at shutdown.
 * Call this once per plugin after all other setup is complete.
 */
export function trackLoadedPlugin(plugin: AutomePlugin): void {
  loadedPlugins.push(plugin);
}
