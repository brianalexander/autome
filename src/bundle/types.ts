import type { WorkflowDefinition } from '../types/workflow.js';

export const BUNDLE_EXTENSION = '.autome';

/** A .autome bundle — a plain JSON file containing the workflow and its requirements. */
export interface Bundle {
  name: string;
  description?: string;
  exportedAt: string;
  sourceProvider: string;
  workflow: WorkflowDefinition;
  requiredAgents: string[];
  requiredMcpServers: string[];
}

/** Result returned by the import process. */
export interface ImportResult {
  workflowId: string;
  warnings: ImportWarning[];
}

export interface ImportWarning {
  type: 'missing_agent' | 'missing_mcp_server';
  name: string;
  message: string;
}

export interface ExportResult {
  bundle: Bundle;
  warnings: ExportWarning[];
}

export interface ExportWarning {
  type: 'missing_agent';
  name: string;
  message: string;
}
