import type { NodeTypeSpec } from '../nodes/types.js';
import type { AcpProvider } from '../acp/provider/types.js';

/** Plugin manifest as declared in autome-plugin.json */
export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Paths to files that default-export a NodeTypeSpec. Relative to plugin dir. */
  nodeTypes?: string[];
  /** Paths/globs to JSON template files. Relative to plugin dir. */
  templates?: string[];
  /** Paths to files that default-export an AcpProvider. Relative to plugin dir. */
  providers?: string[];
}

/** A fully loaded plugin — manifest + resolved artifacts */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin directory (empty string for programmatic plugins) */
  dir: string;
  /** Resolved node type specs (loaded from the files listed in manifest.nodeTypes) */
  nodeTypes: NodeTypeSpec[];
  /** Resolved templates (loaded from the JSON files listed in manifest.templates) */
  templates: NodeTemplate[];
  /** Resolved ACP providers (loaded from the files listed in manifest.providers) */
  providers: AcpProvider[];
}

export interface NodeTemplate {
  id: string;
  name: string;
  description?: string;
  nodeType: string;
  icon?: string;
  category?: string;
  config: Record<string, unknown>;
  /** Field paths users should customize */
  exposed?: string[];
  /** Field paths that shouldn't change */
  locked?: string[];
}
