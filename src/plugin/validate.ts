/**
 * validate.ts
 *
 * Validates loaded AutomePlugin instances against their declared metadata.
 * Does NOT execute registerRoutes, onReady, onClose, or any runtime hooks —
 * only inspects declarative metadata.
 */

import type { AutomePlugin } from './types.js';
import { jsonSchemaToZod } from '../nodes/schema-to-zod.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Severity = 'ok' | 'warning' | 'error';

export interface PluginIssue {
  severity: Severity;
  message: string;
}

export interface PluginValidationResult {
  plugin: AutomePlugin;
  issues: PluginIssue[];
  /** Node type IDs contributed by this plugin */
  nodeTypeIds: string[];
  /** Template IDs contributed by this plugin */
  templateIds: string[];
}

export interface CrossPluginIssue {
  severity: Severity;
  message: string;
}

export interface ValidationReport {
  plugins: PluginValidationResult[];
  /** Issues that span multiple plugins (e.g. duplicate IDs) */
  crossIssues: CrossPluginIssue[];
}

// ---------------------------------------------------------------------------
// Current plugin API version understood by this build
// ---------------------------------------------------------------------------

const CURRENT_API_VERSION = 1;

// Node type ID must start with a lowercase letter, then lowercase letters/digits/hyphens
const NODE_TYPE_ID_RE = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate loaded plugins. Does NOT execute runtime hooks.
 * Only inspects declarative metadata (nodeTypes and templates).
 *
 * Checks performed per plugin:
 *   - apiVersion compat (warning if plugin requests newer than current)
 *   - node type ID format (^[a-z][a-z0-9-]*$)
 *   - node type required fields (id, name, category, executor, configSchema, defaultConfig, etc.)
 *   - configSchema compiles via jsonSchemaToZod (error on malformed)
 *   - defaultConfig validates against configSchema (error on contradiction)
 *   - template required fields (id, name, nodeType, config)
 *   - template.nodeType references a known node type from built-ins OR any loaded plugin
 *
 * Cross-plugin checks:
 *   - duplicate node type IDs across plugins
 *   - duplicate template IDs across plugins
 */
export async function validatePlugins(
  plugins: AutomePlugin[],
  builtinNodeTypes: Set<string>,
): Promise<ValidationReport> {
  const results: PluginValidationResult[] = [];

  // First pass: collect all node type IDs contributed by plugins so template
  // references can be resolved across plugin boundaries.
  const allPluginNodeTypeIds = new Set<string>();
  for (const plugin of plugins) {
    for (const spec of plugin.nodeTypes ?? []) {
      if (spec.id) allPluginNodeTypeIds.add(spec.id);
    }
  }

  // Combined set of known node type IDs for template reference validation.
  const allKnownNodeTypeIds = new Set([...builtinNodeTypes, ...allPluginNodeTypeIds]);

  // Second pass: validate each plugin in detail.
  for (const plugin of plugins) {
    const issues: PluginIssue[] = [];
    const nodeTypeIds: string[] = [];
    const templateIds: string[] = [];

    // --- apiVersion compat ---
    if (plugin.apiVersion !== undefined && plugin.apiVersion > CURRENT_API_VERSION) {
      issues.push({
        severity: 'warning',
        message: `API version ${plugin.apiVersion} requested, current is ${CURRENT_API_VERSION}`,
      });
    }

    // --- node types ---
    for (const spec of plugin.nodeTypes ?? []) {
      // id
      if (!spec.id) {
        issues.push({ severity: 'error', message: 'Node type is missing required field: id' });
        continue; // can't do further checks without an id
      }

      nodeTypeIds.push(spec.id);

      if (!NODE_TYPE_ID_RE.test(spec.id)) {
        issues.push({
          severity: 'error',
          message: `Node type '${spec.id}' has an invalid ID format (must match ^[a-z][a-z0-9-]*$)`,
        });
      }

      // required scalar fields
      if (!spec.name) {
        issues.push({ severity: 'error', message: `Node type '${spec.id}' is missing required field: name` });
      }
      if (!spec.category) {
        issues.push({ severity: 'error', message: `Node type '${spec.id}' is missing required field: category` });
      }
      if (!spec.executor) {
        issues.push({ severity: 'error', message: `Node type '${spec.id}' is missing required field: executor` });
      }
      if (!spec.configSchema) {
        issues.push({
          severity: 'error',
          message: `Node type '${spec.id}' is missing required field: configSchema`,
        });
      }
      if (spec.defaultConfig === undefined || spec.defaultConfig === null) {
        issues.push({
          severity: 'error',
          message: `Node type '${spec.id}' is missing required field: defaultConfig`,
        });
      }

      // configSchema compilation + defaultConfig validation
      if (spec.configSchema && spec.defaultConfig !== undefined) {
        let zodSchema;
        try {
          zodSchema = jsonSchemaToZod(spec.configSchema);
        } catch (err) {
          issues.push({
            severity: 'error',
            message: `Node type '${spec.id}' has a malformed configSchema: ${String(err)}`,
          });
        }

        if (zodSchema) {
          const parseResult = zodSchema.safeParse(spec.defaultConfig);
          if (!parseResult.success) {
            issues.push({
              severity: 'error',
              message: `Node type '${spec.id}' defaultConfig does not match configSchema: ${parseResult.error.message}`,
            });
          }
        }
      }
    }

    // --- templates ---
    for (const tpl of plugin.templates ?? []) {
      // required fields
      if (!tpl.id) {
        issues.push({ severity: 'error', message: 'Template is missing required field: id' });
        continue;
      }

      templateIds.push(tpl.id);

      if (!tpl.name) {
        issues.push({ severity: 'error', message: `Template '${tpl.id}' is missing required field: name` });
      }
      if (!tpl.nodeType) {
        issues.push({ severity: 'error', message: `Template '${tpl.id}' is missing required field: nodeType` });
      }
      if (!tpl.config || typeof tpl.config !== 'object') {
        issues.push({ severity: 'error', message: `Template '${tpl.id}' is missing required field: config` });
      }

      // nodeType reference check
      if (tpl.nodeType && !allKnownNodeTypeIds.has(tpl.nodeType)) {
        issues.push({
          severity: 'error',
          message: `Template '${tpl.id}' references unknown node type '${tpl.nodeType}'`,
        });
      }
    }

    results.push({ plugin, issues, nodeTypeIds, templateIds });
  }

  // Cross-plugin checks: duplicate IDs
  const crossIssues: CrossPluginIssue[] = [];

  const seenNodeTypeIds = new Map<string, string>(); // id -> plugin name
  const seenTemplateIds = new Map<string, string>(); // id -> plugin name

  for (const result of results) {
    for (const id of result.nodeTypeIds) {
      if (seenNodeTypeIds.has(id)) {
        crossIssues.push({
          severity: 'error',
          message: `Duplicate node type ID '${id}' in plugins '${seenNodeTypeIds.get(id)}' and '${result.plugin.name}'`,
        });
      } else {
        seenNodeTypeIds.set(id, result.plugin.name);
      }
    }

    for (const id of result.templateIds) {
      if (seenTemplateIds.has(id)) {
        crossIssues.push({
          severity: 'error',
          message: `Duplicate template ID '${id}' in plugins '${seenTemplateIds.get(id)}' and '${result.plugin.name}'`,
        });
      } else {
        seenTemplateIds.set(id, result.plugin.name);
      }
    }
  }

  return { plugins: results, crossIssues };
}
