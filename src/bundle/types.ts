import type { WorkflowDefinition } from '../types/workflow.js';

export const BUNDLE_EXTENSION = '.autome';

/** A .autome bundle — a plain JSON file containing the workflow and the agents it references. */
export interface Bundle {
  name: string;
  description?: string;
  exportedAt: string;
  sourceProvider: string;
  workflow: WorkflowDefinition;
  /** Names of agents referenced by agent stages. The importer must have these agents installed. */
  requiredAgents: string[];
}

/** Result returned by the import process. */
export interface ImportResult {
  workflowId: string;
  warnings: ImportWarning[];
}

export interface ImportWarning {
  type: 'missing_agent';
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
