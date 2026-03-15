/**
 * Bundle format types for workflow import/export.
 *
 * A .autome bundle is a tar.gz archive containing:
 *   bundle.json      — manifest (this schema)
 *   workflow.json     — the workflow definition
 *   agents/           — agent spec JSON files
 *   resources/        — bundled files referenced by agents
 *     <agentId>/
 *       file/         — file:// resources (home/, rel/, abs/ prefixed)
 *       skill/        — skill:// resources
 *       knowledge/    — knowledgeBase source dirs
 *       hooks/        — hook script files
 */

export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_EXTENSION = '.autome';

/** Top-level manifest stored as bundle.json in the archive. */
export interface BundleManifest {
  /** Schema version of the bundle format. */
  formatVersion: number;
  /** Workflow name. */
  name: string;
  /** Workflow description. */
  description?: string;
  /** ISO timestamp of when the bundle was created. */
  exportedAt: string;
  /** Map of agentId → agent entry with spec path and resource paths. */
  agents: Record<string, BundleAgentEntry>;
  /** External requirements that the importer must satisfy. */
  requirements: BundleRequirements;
}

/** An agent bundled within the archive. */
export interface BundleAgentEntry {
  /** Path to the agent spec JSON within the archive (e.g., "agents/code-reviewer.json"). */
  spec: string;
  /** Paths to all resource files within the archive for this agent. */
  resources: string[];
}

/** External dependencies not included in the bundle. */
export interface BundleRequirements {
  /** MCP server commands the workflow's agents depend on (e.g., ["git-mcp", "npx"]). Checked via `which`. */
  mcpServers: string[];
  /** System commands used in agent hooks (e.g., ["bash", "node", "gh"]). */
  systemDependencies: string[];
  /** Named secrets/env vars referenced by agents or MCP servers. */
  secrets: string[];
}

/** Result returned by the import process. */
export interface ImportResult {
  /** The created workflow ID. */
  workflowId: string;
  /** Agents that were imported. */
  importedAgents: string[];
  /** Resource files that were extracted. */
  extractedResources: string[];
  /** Warnings about missing system dependencies, MCP servers, etc. */
  warnings: ImportWarning[];
}

export interface ImportWarning {
  type: 'missing_dependency' | 'missing_mcp_server' | 'missing_secret' | 'agent_conflict';
  message: string;
}

/**
 * Path prefix classification for resource URIs.
 * Used to prevent collisions when ~/A, ./A, and /A all normalize differently.
 */
export type PathOrigin = 'home' | 'rel' | 'abs';

/**
 * Resolves a file:// or skill:// URI's origin type.
 *   file://~/...   → 'home'
 *   file://./...   → 'rel'
 *   file://foo/... → 'rel'  (implicit relative)
 *   file:///...    → 'abs'
 */
export function classifyPathOrigin(uri: string): PathOrigin {
  // Strip the scheme (file://, skill://)
  const path = uri.replace(/^(?:file|skill):\/\//, '');
  if (path.startsWith('~/') || path === '~') return 'home';
  if (path.startsWith('/')) return 'abs';
  return 'rel';
}

/**
 * Strips the root anchor from a path, returning the "portable" relative portion.
 *   ~/docs/a.md   → docs/a.md
 *   ./docs/a.md   → docs/a.md
 *   /etc/conf.md  → etc/conf.md
 *   docs/a.md     → docs/a.md
 */
export function stripRootAnchor(path: string): string {
  return path.replace(/^~\//, '').replace(/^\.\//, '').replace(/^\//, '');
}
