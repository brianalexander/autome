/**
 * Manual Trigger — entry point for workflows triggered via UI button or API call.
 * Metadata-only spec; actual trigger logic is in the API endpoints.
 */
import type { NodeTypeSpec, TriggerExecutor } from '../types.js';

const executor: TriggerExecutor = { type: 'trigger' };

export const manualTriggerSpec: NodeTypeSpec = {
  id: 'manual-trigger',
  name: 'Manual Trigger',
  category: 'trigger',
  description: 'Trigger a workflow manually via UI button or API call',
  icon: '✋',
  color: { bg: '#f0fdfa', border: '#14b8a6', text: '#0d9488' },
  configSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', const: 'manual', default: 'manual' },
    },
  },
  defaultConfig: { provider: 'manual' },
  triggerMode: 'prompt',
  executor,
};
