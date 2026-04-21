/**
 * Manual Trigger — entry point for workflows triggered via UI button or API call.
 * Metadata-only spec; actual trigger logic is in the API endpoints.
 */
import type { NodeTypeSpec, TriggerExecutor, ConfigCard } from '../types.js';

const executor: TriggerExecutor = { type: 'trigger' };

export const manualTriggerSpec: NodeTypeSpec = {
  id: 'manual-trigger',
  name: 'Manual Trigger',
  category: 'trigger',
  description: 'Trigger a workflow manually via UI button or API call',
  icon: 'play',
  color: { bg: '#f0fdfa', border: '#14b8a6', text: '#0d9488' },
  configSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', const: 'manual', default: 'manual' },
      output_schema: {
        type: 'object',
        title: 'Payload Schema',
        description: 'JSON Schema describing the trigger payload. Used to generate the trigger form and validate downstream references.',
        format: 'json',
      },
    },
    required: ['output_schema'],
  },
  defaultConfig: {
    provider: 'manual',
    output_schema: {
      type: 'object',
      properties: {},
    },
  },
  triggerMode: 'prompt',
  executor,
  configCards: [
    {
      kind: 'curl-snippet',
      title: 'Usage',
      template: `Click **Run** on the workflow page, or use the API:

\`\`\`
POST {apiOrigin}/api/workflows/{workflowId}/trigger
{ "payload": { "your_field": "your_value" } }
\`\`\`

Downstream edges reference trigger output via \`{{ output.your_field }}\` in prompt templates.`,
    } satisfies ConfigCard,
  ],
};
