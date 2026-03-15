import { EventEmitter } from 'events';
import type { Event, EventProvider } from '../types/events.js';

export interface EventSubscription {
  id: string;
  provider: string;
  eventType: string;
  filter?: Record<string, unknown>;
  workflowDefinitionId: string;
}

export class EventBus extends EventEmitter {
  private providers: Map<string, EventProvider> = new Map();
  private subscriptions: EventSubscription[] = [];

  registerProvider(provider: EventProvider): void {
    this.providers.set(provider.id, provider);
  }

  async unregisterProvider(id: string): Promise<void> {
    const provider = this.providers.get(id);
    if (provider) {
      await provider.stop();
      this.providers.delete(id);
    }
  }

  getProvider(id: string): EventProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): EventProvider[] {
    return Array.from(this.providers.values());
  }

  addSubscription(sub: EventSubscription): void {
    this.subscriptions.push(sub);
  }

  removeSubscription(id: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
  }

  removeSubscriptionsForWorkflow(workflowDefinitionId: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.workflowDefinitionId !== workflowDefinitionId);
  }

  getSubscriptions(): EventSubscription[] {
    return [...this.subscriptions];
  }

  // Called when a provider emits an event
  async handleEvent(event: Event): Promise<void> {
    // Find matching subscriptions
    const matching = this.subscriptions.filter((sub) => {
      if (sub.provider !== event.provider) return false;
      if (sub.eventType !== event.type) return false;
      // Basic filter matching (if filter is set, check all keys match)
      if (sub.filter) {
        const payload = event.payload as Record<string, unknown> | null | undefined;
        for (const [key, value] of Object.entries(sub.filter)) {
          if (payload?.[key] !== value) return false;
        }
      }
      return true;
    });

    // Emit for each match — the engine will listen and spawn instances
    for (const sub of matching) {
      this.emit('trigger', {
        subscription: sub,
        event,
      });
    }

    // Also emit for watchers on running instances
    this.emit('watcher_event', event);
  }

  async startAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.start((event) => this.handleEvent(event));
    }
  }

  async stopAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.stop();
    }
  }
}
