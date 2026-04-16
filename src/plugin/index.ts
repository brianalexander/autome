// Plugin API
export { definePlugin } from './types.js';
export type { AutomePlugin, NodeTemplate, PluginContext } from './types.js';

// Re-export types that plugins depend on
export type { NodeTypeSpec, StepExecutor, TriggerExecutor, StepExecutorContext, StageInput, NodeColor } from '../nodes/types.js';
export type { RouteDeps, SharedState } from '../api/routes/shared.js';

// Re-export workflow types
export type { WorkflowDefinition, EdgeDefinition, NodeTypeInfo } from '../types/workflow.js';
