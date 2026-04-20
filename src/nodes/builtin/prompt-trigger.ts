/**
 * Prompt Trigger — a chat-style trigger for ad-hoc natural-language inputs.
 * Fixed output schema { prompt: string, attachments?: array }.
 * The trigger form renders a dedicated textarea instead of a generic JSON form.
 */
import type { NodeTypeSpec, TriggerExecutor } from '../types.js';

const executor: TriggerExecutor = { type: 'trigger' };

export const promptTriggerSpec: NodeTypeSpec = {
  id: 'prompt-trigger',
  name: 'Prompt Trigger',
  category: 'trigger',
  description:
    'Chat-style trigger for ad-hoc prompts. User types natural language to kick off a run. Fixed output schema { prompt: string, attachments?: array }.',
  icon: 'message-square',
  color: { bg: '#ecfeff', border: '#06b6d4', text: '#0891b2' },
  configSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', const: 'prompt', default: 'prompt' },
      // output_schema intentionally omitted — it is fixed and not user-configurable.
      // The generic StageConfigForm must not render it.
    },
    required: [],
  },
  defaultConfig: {
    provider: 'prompt',
    output_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The user-provided prompt text' },
        attachments: {
          type: 'array',
          description: 'Optional file attachments (future use)',
          items: { type: 'object' },
        },
      },
      required: ['prompt'],
    },
  },
  triggerMode: 'prompt',
  executor,
};
