/**
 * Node Type Registry — singleton that maps node type IDs to their specs.
 * Initialized once at startup by the server.
 */
import { z } from 'zod';
import type { NodeTypeSpec, NodeTypeInfo } from './types.js';
import { jsonSchemaToZod } from './schema-to-zod.js';

export class NodeTypeRegistry {
  private specs = new Map<string, NodeTypeSpec>();
  private configSchemas = new Map<string, z.ZodType>();

  register(spec: NodeTypeSpec): void {
    if (this.specs.has(spec.id)) {
      console.warn(`[node-registry] Node type "${spec.id}" already registered, overwriting`);
    }
    this.specs.set(spec.id, spec);
    if (spec.configSchema) {
      this.configSchemas.set(spec.id, jsonSchemaToZod(spec.configSchema));
    }
  }

  getConfigZodSchema(id: string): z.ZodType | undefined {
    return this.configSchemas.get(id);
  }

  get(id: string): NodeTypeSpec | undefined {
    return this.specs.get(id);
  }

  getAll(): NodeTypeSpec[] {
    return Array.from(this.specs.values());
  }

  getByCategory(category: 'trigger' | 'step'): NodeTypeSpec[] {
    return this.getAll().filter((s) => s.category === category);
  }

  /** Check if a stage type ID is a trigger (by registry category lookup). */
  isTriggerType(typeId: string): boolean {
    const spec = this.specs.get(typeId);
    return spec?.category === 'trigger';
  }

  /** Returns frontend-safe metadata (no executor functions) */
  getAllInfo(): NodeTypeInfo[] {
    return this.getAll().map((spec) => {
      const { executor, ...rest } = spec;
      const hasLifecycle =
        executor.type === 'trigger' && typeof (executor as { activate?: unknown }).activate === 'function';
      const hasSampleEvent =
        executor.type === 'trigger' && typeof (executor as { sampleEvent?: unknown }).sampleEvent === 'function';
      // configCards passes through via ...rest — no executor-stripping needed
      return { ...rest, executorType: executor.type, hasLifecycle, hasSampleEvent };
    });
  }
}

/** Singleton registry instance — shared within each process */
export const nodeRegistry = new NodeTypeRegistry();

/**
 * Initialize the registry with all built-in node types.
 * Called once at server startup.
 */
export async function initializeRegistry(): Promise<void> {
  const { allBuiltinSpecs } = await import('./builtin/index.js');
  for (const spec of allBuiltinSpecs) {
    nodeRegistry.register(spec);
  }
  console.log(`[node-registry] Registered ${allBuiltinSpecs.length} built-in node type(s)`);

  // Discover and register custom nodes — failures are non-fatal
  try {
    const { discoverCustomNodes } = await import('./custom/loader.js');
    const customSpecs = await discoverCustomNodes();
    for (const spec of customSpecs) {
      if (nodeRegistry.get(spec.id)) {
        console.warn(`[node-registry] Custom node "${spec.id}" conflicts with existing type — skipping`);
        continue;
      }
      nodeRegistry.register(spec);
    }
    if (customSpecs.length > 0) {
      console.log(`[node-registry] Registered ${customSpecs.length} custom node type(s)`);
    }
  } catch (err) {
    console.warn('[node-registry] Custom node discovery failed (non-fatal):', err);
  }
}
