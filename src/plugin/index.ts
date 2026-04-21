// Plugin API — types
export type { PluginManifest, LoadedPlugin, NodeTemplate } from './types.js';

// Re-export types that plugins depend on
export type { NodeTypeSpec, StepExecutor, TriggerExecutor, TriggerActivateContext, TriggerLogger, StepExecutorContext, StageInput, NodeColor } from '../nodes/types.js';

// Re-export workflow types
export type { WorkflowDefinition, EdgeDefinition, NodeTypeInfo } from '../types/workflow.js';

// Re-export provider type for plugins that declare providers
export type { AcpProvider } from '../acp/provider/types.js';

// ---------------------------------------------------------------------------
// Runtime helpers — identity functions for type inference and programmatic use
// ---------------------------------------------------------------------------

import type { PluginManifest, LoadedPlugin, NodeTemplate } from './types.js';
import type { NodeTypeSpec } from '../nodes/types.js';
import type { AcpProvider } from '../acp/provider/types.js';

/**
 * Define a plugin for programmatic registration via `createCli` or `startServer`.
 * The returned `LoadedPlugin` can be passed directly to `startServer({ plugins: [...] })`.
 */
export function definePlugin(
  manifest: PluginManifest,
  assets?: {
    nodeTypes?: NodeTypeSpec[];
    templates?: NodeTemplate[];
    providers?: AcpProvider[];
  },
): LoadedPlugin {
  return {
    manifest,
    dir: '',
    nodeTypes: assets?.nodeTypes ?? [],
    templates: assets?.templates ?? [],
    providers: assets?.providers ?? [],
  };
}

/** Identity helper — enables TypeScript inference for node type specs. */
export function defineNodeType(spec: NodeTypeSpec): NodeTypeSpec {
  return spec;
}

/** Identity helper — enables TypeScript inference for template objects. */
export function defineTemplate(template: NodeTemplate): NodeTemplate {
  return template;
}

/** Identity helper — enables TypeScript inference for ACP provider objects. */
export function defineProvider(provider: AcpProvider): AcpProvider {
  return provider;
}
