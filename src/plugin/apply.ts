import type { LoadedPlugin, NodeTemplate } from './types.js';
import type { NodeTypeRegistry } from '../nodes/registry.js';
import type { OrchestratorDB } from '../db/database.js';
import type { AcpProvider } from '../acp/provider/types.js';

/**
 * Sync a list of templates into the DB under the given source key.
 * Re-used by both applyPlugins() and direct programmatic template registration.
 */
export async function applyTemplates(
  templates: NodeTemplate[],
  source: string,
  _registry: NodeTypeRegistry,
  db: OrchestratorDB,
): Promise<void> {
  for (const tpl of templates) {
    try {
      const existing = db.getNodeTemplate(tpl.id);
      if (!existing) {
        db.createNodeTemplate({ ...tpl, source });
        console.log(`[plugins] Registered template: ${tpl.name} (${tpl.id})`);
      } else if (existing.source === source) {
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

/**
 * Apply loaded plugins:
 * 1. Register each plugin's node types into the registry.
 * 2. Sync each plugin's templates into the DB.
 * 3. Collect and return any providers declared by the plugins.
 *
 * Template sync logic:
 * - Creates the template if it doesn't exist yet.
 * - Updates it if the existing record came from the same plugin source.
 * - Skips it if another source owns the record (avoids stomping user edits).
 *
 * Returns the collected ACP providers so the caller can register them.
 */
export async function applyPlugins(
  plugins: LoadedPlugin[],
  nodeRegistry: NodeTypeRegistry,
  db: OrchestratorDB,
): Promise<AcpProvider[]> {
  const collectedProviders: AcpProvider[] = [];

  for (const plugin of plugins) {
    // Register node types
    if (plugin.nodeTypes.length > 0) {
      for (const spec of plugin.nodeTypes) {
        nodeRegistry.register(spec);
      }
      console.log(`[plugins] Registered ${plugin.nodeTypes.length} node type(s) from "${plugin.manifest.name}"`);
    }

    // Sync templates
    if (plugin.templates.length > 0) {
      const source = `plugin:${plugin.manifest.id}`;
      await applyTemplates(plugin.templates, source, nodeRegistry, db);
    }

    // Collect providers
    if (plugin.providers.length > 0) {
      for (const provider of plugin.providers) {
        collectedProviders.push(provider);
        console.log(`[plugins] Registered provider "${provider.name}" from "${plugin.manifest.name}"`);
      }
    }
  }

  return collectedProviders;
}
