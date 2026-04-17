import type { NodeTypeSpec } from '../nodes/types.js';

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
}

/** A fully loaded plugin — manifest + resolved artifacts */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin directory */
  dir: string;
  /** Resolved node type specs (loaded from the files listed in manifest.nodeTypes) */
  nodeTypes: NodeTypeSpec[];
  /** Resolved templates (loaded from the JSON files listed in manifest.templates) */
  templates: NodeTemplate[];
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
