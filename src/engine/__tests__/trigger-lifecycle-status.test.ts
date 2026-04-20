/**
 * Tests for Phase 4 trigger-lifecycle status tracking.
 *
 * Covers:
 * - TriggerStatus tracks eventCount, errorCount, lastError correctly
 * - TriggerLogger appends to ring buffer and to console
 * - Ring buffer is bounded at 200 entries
 * - getWorkflowTriggerStatuses / getTriggerLogs read API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../events/bus.js';
import {
  initTriggerLifecycle,
  activateWorkflowTriggers,
  deactivateWorkflowTriggers,
  getWorkflowTriggerStatuses,
  getTriggerLogs,
  makeLogger,
  resetForTesting,
} from '../trigger-lifecycle.js';
import { initializeRegistry, nodeRegistry } from '../../nodes/registry.js';
import type { NodeTypeSpec, TriggerExecutor, TriggerActivateContext } from '../../nodes/types.js';

// ---------------------------------------------------------------------------
// Mock broadcast to avoid real WS infrastructure
// ---------------------------------------------------------------------------
vi.mock('../../api/websocket.js', () => ({ broadcast: vi.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBus(): EventBus {
  const bus = new EventBus();
  return bus;
}

/** Build a minimal WorkflowDefinition for testing. */
function makeWorkflow(overrides: { id?: string; stages?: unknown[] } = {}): {
  id: string;
  name: string;
  active: boolean;
  trigger: { provider: string };
  stages: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
  edges: unknown[];
  version: number;
} {
  return {
    id: overrides.id ?? 'wf-test',
    name: 'Test Workflow',
    active: true,
    trigger: { provider: 'cron-trigger' },
    stages: (overrides.stages as Array<{ id: string; type: string }>) ?? [],
    edges: [],
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initializeRegistry();
  resetForTesting();
});

afterEach(() => {
  resetForTesting();
});

// ---------------------------------------------------------------------------
// makeLogger unit tests
// ---------------------------------------------------------------------------

describe('makeLogger', () => {
  it('appends INFO/WARN lines to the ring buffer via activate', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    // Register a mock trigger type
    const mockActivate = vi.fn().mockImplementation(async (ctx: TriggerActivateContext) => {
      ctx.logger.info('startup message');
      ctx.logger.warn('a warning');
      return () => {};
    });

    const mockSpec: NodeTypeSpec = {
      id: 'mock-trigger',
      name: 'Mock Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: { type: 'trigger', activate: mockActivate } as TriggerExecutor,
    };
    nodeRegistry.register(mockSpec);

    const workflow = makeWorkflow({
      stages: [{ id: 'trig1', type: 'mock-trigger', config: {} }],
    });

    await activateWorkflowTriggers(workflow as never);

    const logs = getTriggerLogs('wf-test', 'trig1');
    expect(logs.some((l) => l.includes('[INFO] startup message'))).toBe(true);
    expect(logs.some((l) => l.includes('[WARN] a warning'))).toBe(true);
  });

  it('records error in status on logger.error()', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    const mockSpec: NodeTypeSpec = {
      id: 'error-trigger',
      name: 'Error Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          ctx.logger.error('something went wrong', new Error('boom'));
          return () => {};
        },
      } as TriggerExecutor,
    };
    nodeRegistry.register(mockSpec);

    const workflow = makeWorkflow({
      id: 'wf-error',
      stages: [{ id: 'err_trig', type: 'error-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    const statuses = getWorkflowTriggerStatuses('wf-error');
    const s = statuses['err_trig'];
    expect(s).toBeDefined();
    expect(s.errorCount).toBe(1);
    expect(s.lastError).toContain('something went wrong');
    expect(s.state).toBe('errored');
    expect(s.lastErrorAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle status transitions
// ---------------------------------------------------------------------------

describe('TriggerStatus tracking', () => {
  it('transitions from starting → active after successful activate', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    nodeRegistry.register({
      id: 'active-trigger',
      name: 'Active Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (_ctx: TriggerActivateContext) => () => {},
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-active',
      stages: [{ id: 'at1', type: 'active-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    const statuses = getWorkflowTriggerStatuses('wf-active');
    expect(statuses['at1']).toBeDefined();
    expect(statuses['at1'].state).toBe('active');
    expect(statuses['at1'].startedAt).toBeTruthy();
  });

  it('tracks eventCount and lastEventAt when emit is called', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    let capturedEmit: ((p: Record<string, unknown>) => void) | undefined;

    nodeRegistry.register({
      id: 'emit-trigger',
      name: 'Emit Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          capturedEmit = ctx.emit;
          return () => {};
        },
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-emit',
      stages: [{ id: 'em1', type: 'emit-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    expect(capturedEmit).toBeDefined();

    // Initial: no events
    let statuses = getWorkflowTriggerStatuses('wf-emit');
    expect(statuses['em1'].eventCount).toBe(0);
    expect(statuses['em1'].lastEventAt).toBeNull();

    // Emit once (event bus routes to subscriptions — bus has no subscriber so it's a no-op)
    capturedEmit!({ type: 'test', value: 1 });

    statuses = getWorkflowTriggerStatuses('wf-emit');
    expect(statuses['em1'].eventCount).toBe(1);
    expect(statuses['em1'].lastEventAt).toBeTruthy();
  });

  it('sets state=stopped after deactivation', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    nodeRegistry.register({
      id: 'stop-trigger',
      name: 'Stop Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (_ctx: TriggerActivateContext) => () => {},
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-stop',
      stages: [{ id: 'st1', type: 'stop-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);
    expect(getWorkflowTriggerStatuses('wf-stop')['st1'].state).toBe('active');

    deactivateWorkflowTriggers('wf-stop');

    // After deactivation the stageMap is removed
    expect(getWorkflowTriggerStatuses('wf-stop')).toEqual({});
  });

  it('returns logsPreview with last 10 lines', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    nodeRegistry.register({
      id: 'log-preview-trigger',
      name: 'Log Preview Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          for (let i = 0; i < 25; i++) {
            ctx.logger.info(`line ${i}`);
          }
          return () => {};
        },
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-preview',
      stages: [{ id: 'lp1', type: 'log-preview-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    const logs = getTriggerLogs('wf-preview', 'lp1');
    const statuses = getWorkflowTriggerStatuses('wf-preview');
    expect(statuses['lp1'].logsPreview).toHaveLength(10);
    // 25 user lines + 1 "Activated..." line = 26 total. Preview is last 10.
    // The last line is the "Activated" lifecycle message.
    expect(logs.some((l) => l.includes('line 24'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ring buffer bounded at 200
// ---------------------------------------------------------------------------

describe('ring buffer', () => {
  it('never exceeds 200 log lines', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    nodeRegistry.register({
      id: 'flood-trigger',
      name: 'Flood Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          for (let i = 0; i < 250; i++) {
            ctx.logger.info(`log line ${i}`);
          }
          return () => {};
        },
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-flood',
      stages: [{ id: 'fl1', type: 'flood-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    // 250 user logs + 1 lifecycle "Activated..." log = 251 total written.
    // Buffer is bounded at 200; oldest 51 are dropped.
    const logs = getTriggerLogs('wf-flood', 'fl1');
    expect(logs.length).toBe(200);
    // The last entry is the "Activated" lifecycle message, so log line 249 should still be present somewhere
    expect(logs.some((l) => l.includes('log line 249'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getTriggerLogs respects limit param
// ---------------------------------------------------------------------------

describe('getTriggerLogs', () => {
  it('returns empty array for unknown workflow/stage', () => {
    expect(getTriggerLogs('nope', 'also-nope')).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const bus = makeBus();
    initTriggerLifecycle(bus);

    nodeRegistry.register({
      id: 'limit-trigger',
      name: 'Limit Trigger',
      category: 'trigger',
      description: 'test',
      icon: 'zap',
      color: { bg: '#fff', border: '#000', text: '#000' },
      configSchema: { type: 'object', properties: {} },
      defaultConfig: {},
      executor: {
        type: 'trigger',
        activate: async (ctx: TriggerActivateContext) => {
          for (let i = 0; i < 100; i++) {
            ctx.logger.info(`msg ${i}`);
          }
          return () => {};
        },
      } as TriggerExecutor,
    });

    const workflow = makeWorkflow({
      id: 'wf-limit',
      stages: [{ id: 'lm1', type: 'limit-trigger' }],
    });

    await activateWorkflowTriggers(workflow as never);

    const logs = getTriggerLogs('wf-limit', 'lm1', 20);
    expect(logs.length).toBe(20);
    // 100 user logs + 1 lifecycle "Activated..." log = 101 total.
    // Last 20 includes the lifecycle message as last entry.
    // Lines 82-99 of user msgs should be in the last 19 slots.
    expect(logs.some((l) => l.includes('msg 99'))).toBe(true);
  });
});
