/**
 * Webhook Trigger — entry point for workflows triggered by an incoming HTTP POST.
 * Metadata-only spec; actual webhook handling is in the API endpoints.
 */
import type { NodeTypeSpec, TriggerExecutor } from '../types.js';

const executor: TriggerExecutor = { type: 'trigger' };

export const webhookTriggerSpec: NodeTypeSpec = {
  id: 'webhook-trigger',
  name: 'Webhook Trigger',
  category: 'trigger',
  description: 'Trigger a workflow via an incoming HTTP POST request',
  icon: 'globe',
  color: { bg: '#f5f3ff', border: '#8b5cf6', text: '#7c3aed' },
  configSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', const: 'webhook', default: 'webhook' },
      secret: { type: 'string', title: 'Secret', description: 'Optional HMAC secret for signature validation' },
      payload_filter: {
        type: 'string',
        title: 'Payload Filter',
        description: 'JS expression to filter/transform incoming payloads. The variable `payload` contains the raw HTTP request body. Return a falsy value to reject the event, or return a transformed object.',
        format: 'code',
      },
      payload_schema: {
        type: 'object',
        title: 'Expected Payload Schema',
        description: "JSON Schema defining the expected webhook payload structure. Incoming payloads that don't match are rejected with a 422 error.",
        format: 'json',
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing the trigger output after filtering. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['payload_schema'],
  },
  defaultConfig: { provider: 'webhook' },
  triggerMode: 'prompt',
  executor,
};
