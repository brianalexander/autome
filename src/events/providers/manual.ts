import { v4 as uuid } from 'uuid';
import type { Event, EventProvider, EventTypeDescriptor } from '../../types/events.js';

export class ManualTriggerProvider implements EventProvider {
  id = 'manual';
  name = 'Manual Trigger';
  private emitCallback: ((event: Event) => void) | null = null;

  getEventTypes(): EventTypeDescriptor[] {
    return [
      {
        type: 'trigger',
        description: 'Manually triggered by a user via the API or UI',
        payload_schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    ];
  }

  async start(emitCallback: (event: Event) => void): Promise<void> {
    this.emitCallback = emitCallback;
  }

  async stop(): Promise<void> {
    this.emitCallback = null;
  }

  validateConfig(_config: unknown): { valid: boolean; errors?: string[] } {
    return { valid: true };
  }

  // Called by the API to manually trigger a workflow
  trigger(payload?: unknown): Event {
    const event: Event = {
      id: uuid(),
      provider: 'manual',
      type: 'trigger',
      timestamp: new Date().toISOString(),
      payload: payload || {},
    };

    if (this.emitCallback) {
      this.emitCallback(event);
    }

    return event;
  }
}
