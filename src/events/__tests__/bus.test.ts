import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../bus.js';
import { ManualTriggerProvider } from '../providers/manual.js';
import type { Event, EventProvider } from '../../types/events.js';
import type { EventSubscription } from '../bus.js';

function makeProvider(id = 'test-provider'): EventProvider {
  return {
    id,
    name: `Provider ${id}`,
    getEventTypes: () => [{ type: 'push', description: 'A push event' }],
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue({ valid: true }),
  };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-1',
    provider: 'test-provider',
    type: 'push',
    timestamp: new Date().toISOString(),
    payload: { ref: 'main' },
    ...overrides,
  };
}

function makeSub(overrides: Partial<EventSubscription> = {}): EventSubscription {
  return {
    id: 'sub-1',
    provider: 'test-provider',
    eventType: 'push',
    workflowDefinitionId: 'pipeline-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

describe('register and list providers', () => {
  it('registers a provider and retrieves it', () => {
    const bus = new EventBus();
    const provider = makeProvider('p1');
    bus.registerProvider(provider);

    expect(bus.getProvider('p1')).toBe(provider);
    expect(bus.listProviders()).toHaveLength(1);
    expect(bus.listProviders()[0]).toBe(provider);
  });

  it('lists multiple registered providers', () => {
    const bus = new EventBus();
    bus.registerProvider(makeProvider('p1'));
    bus.registerProvider(makeProvider('p2'));

    expect(bus.listProviders()).toHaveLength(2);
  });

  it('returns undefined for an unregistered provider', () => {
    const bus = new EventBus();
    expect(bus.getProvider('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

describe('add and remove subscriptions', () => {
  it('adds a subscription and returns it via getSubscriptions', () => {
    const bus = new EventBus();
    const sub = makeSub();
    bus.addSubscription(sub);

    const subs = bus.getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual(sub);
  });

  it('removes a subscription by id', () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ id: 'sub-1' }));
    bus.addSubscription(makeSub({ id: 'sub-2' }));
    bus.removeSubscription('sub-1');

    const subs = bus.getSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe('sub-2');
  });

  it('getSubscriptions returns a copy, not the internal array', () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub());

    const subs = bus.getSubscriptions();
    subs.push(makeSub({ id: 'intruder' }));

    expect(bus.getSubscriptions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

describe('event matching', () => {
  it('triggers the correct subscription when provider and type match', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub());

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent());

    expect(triggered).toHaveLength(1);
    expect(triggered[0].subscription.id).toBe('sub-1');
    expect(triggered[0].event.type).toBe('push');
  });

  it('does not trigger when provider does not match', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ provider: 'other-provider' }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent({ provider: 'test-provider' }));

    expect(triggered).toHaveLength(0);
  });

  it('does not trigger when event type does not match', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ eventType: 'pull_request' }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent({ type: 'push' }));

    expect(triggered).toHaveLength(0);
  });

  it('triggers when all filter keys match the event payload', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ filter: { ref: 'main', action: 'opened' } }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent({ payload: { ref: 'main', action: 'opened', extra: 'ignored' } }));

    expect(triggered).toHaveLength(1);
  });

  it('does not trigger when a filter value does not match', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ filter: { ref: 'main' } }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent({ payload: { ref: 'develop' } }));

    expect(triggered).toHaveLength(0);
  });

  it('fires all matching subscriptions when multiple match', async () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ id: 'sub-1', workflowDefinitionId: 'pipeline-1' }));
    bus.addSubscription(makeSub({ id: 'sub-2', workflowDefinitionId: 'pipeline-2' }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.handleEvent(makeEvent());

    expect(triggered).toHaveLength(2);
    const ids = triggered.map((t) => t.subscription.id);
    expect(ids).toContain('sub-1');
    expect(ids).toContain('sub-2');
  });

  it('emits watcher_event for every event regardless of subscriptions', async () => {
    const bus = new EventBus();
    const watcherEvents: Event[] = [];
    bus.on('watcher_event', (e) => watcherEvents.push(e));

    const event = makeEvent();
    await bus.handleEvent(event);

    expect(watcherEvents).toHaveLength(1);
    expect(watcherEvents[0]).toBe(event);
  });
});

// ---------------------------------------------------------------------------
// removeSubscriptionsForWorkflow
// ---------------------------------------------------------------------------

describe('removeSubscriptionsForWorkflow', () => {
  it('removes all subscriptions for a given workflow definition id', () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ id: 'sub-1', workflowDefinitionId: 'pipeline-A' }));
    bus.addSubscription(makeSub({ id: 'sub-2', workflowDefinitionId: 'pipeline-A' }));
    bus.addSubscription(makeSub({ id: 'sub-3', workflowDefinitionId: 'pipeline-B' }));

    bus.removeSubscriptionsForWorkflow('pipeline-A');

    const remaining = bus.getSubscriptions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('sub-3');
  });

  it('is a no-op when no subscriptions exist for that workflow', () => {
    const bus = new EventBus();
    bus.addSubscription(makeSub({ id: 'sub-1', workflowDefinitionId: 'pipeline-B' }));

    bus.removeSubscriptionsForWorkflow('pipeline-A');

    expect(bus.getSubscriptions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// startAll / stopAll
// ---------------------------------------------------------------------------

describe('startAll and stopAll', () => {
  it('calls start on all registered providers', async () => {
    const bus = new EventBus();
    const p1 = makeProvider('p1');
    const p2 = makeProvider('p2');
    bus.registerProvider(p1);
    bus.registerProvider(p2);

    await bus.startAll();

    expect(p1.start).toHaveBeenCalledOnce();
    expect(p2.start).toHaveBeenCalledOnce();
  });

  it('calls stop on all registered providers', async () => {
    const bus = new EventBus();
    const p1 = makeProvider('p1');
    const p2 = makeProvider('p2');
    bus.registerProvider(p1);
    bus.registerProvider(p2);

    await bus.stopAll();

    expect(p1.stop).toHaveBeenCalledOnce();
    expect(p2.stop).toHaveBeenCalledOnce();
  });

  it('passes a callback to start that routes events through handleEvent', async () => {
    const bus = new EventBus();
    let capturedCallback: ((event: Event) => void) | null = null;

    const provider: EventProvider = {
      id: 'p1',
      name: 'P1',
      getEventTypes: () => [],
      start: vi.fn().mockImplementation(async (cb) => {
        capturedCallback = cb;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      validateConfig: vi.fn().mockReturnValue({ valid: true }),
    };

    bus.registerProvider(provider);
    bus.addSubscription(makeSub({ provider: 'p1' }));

    const triggered: any[] = [];
    bus.on('trigger', (data) => triggered.push(data));

    await bus.startAll();

    expect(capturedCallback).not.toBeNull();
    capturedCallback!(makeEvent({ provider: 'p1' }));

    // handleEvent is async but triggered synchronously from the callback path
    await Promise.resolve();

    expect(triggered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ManualTriggerProvider
// ---------------------------------------------------------------------------

describe('ManualTriggerProvider', () => {
  it('getEventTypes returns the manual trigger descriptor', () => {
    const provider = new ManualTriggerProvider();
    const types = provider.getEventTypes();

    expect(types).toHaveLength(1);
    expect(types[0].type).toBe('trigger');
    expect(types[0].description).toBeTruthy();
    expect(types[0].payload_schema).toBeDefined();
  });

  it('trigger() creates a well-formed event and calls the emitCallback', async () => {
    const provider = new ManualTriggerProvider();
    const emitted: Event[] = [];
    await provider.start((e) => emitted.push(e));

    const event = provider.trigger();

    expect(event.provider).toBe('manual');
    expect(event.type).toBe('trigger');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    expect(event.payload).toEqual({});
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(event);
  });

  it('trigger() includes custom payload in the event', async () => {
    const provider = new ManualTriggerProvider();
    const emitted: Event[] = [];
    await provider.start((e) => emitted.push(e));

    const event = provider.trigger({ message: 'hello', run_id: 42 });

    expect(event.payload).toEqual({ message: 'hello', run_id: 42 });
    expect(emitted[0].payload).toEqual({ message: 'hello', run_id: 42 });
  });

  it('trigger() does not call emitCallback after stop()', async () => {
    const provider = new ManualTriggerProvider();
    const emitted: Event[] = [];
    await provider.start((e) => emitted.push(e));
    await provider.stop();

    provider.trigger();

    expect(emitted).toHaveLength(0);
  });

  it('validateConfig always returns valid', () => {
    const provider = new ManualTriggerProvider();
    expect(provider.validateConfig({})).toEqual({ valid: true });
    expect(provider.validateConfig(null)).toEqual({ valid: true });
  });
});
