import type { NodeTypeSpec } from '../nodes/types.js';
import type { FastifyInstance } from 'fastify';
import type { NodeTypeRegistry } from '../nodes/registry.js';
import type { EventBus } from '../events/bus.js';
import type { RouteDeps, SharedState } from '../api/routes/shared.js';

export interface AutomePlugin {
  /** Unique plugin name (e.g., 'acme-proprietary') */
  name: string;
  /** Semver version */
  version?: string;
  /** Plugin API version this plugin targets */
  apiVersion?: number;
  /** Custom node types — backend executors with frontend metadata */
  nodeTypes?: NodeTypeSpec[];
  /** Node templates — pre-configured node snapshots */
  templates?: NodeTemplate[];
  /** Register additional Fastify routes */
  registerRoutes?: (app: FastifyInstance, deps: RouteDeps, state: SharedState) => void | Promise<void>;
  /** Hook: called after core initialization, before server.listen() */
  onReady?: (ctx: PluginContext) => void | Promise<void>;
  /** Hook: called during graceful shutdown */
  onClose?: () => void | Promise<void>;
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

export interface PluginContext {
  nodeRegistry: NodeTypeRegistry;
  eventBus: EventBus;
}

/** Helper for type inference */
export function definePlugin(plugin: AutomePlugin): AutomePlugin {
  return plugin;
}

export type { RouteDeps, SharedState };
