import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { nodeRegistry, initializeRegistry, NodeTypeRegistry } from '../registry.js';
import type { NodeTypeSpec, TriggerExecutor, StepExecutor } from '../types.js';

beforeAll(async () => {
  await initializeRegistry();
});

describe('registry initialization', () => {
  it('registers all built-in specs', () => {
    expect(nodeRegistry.getAll().length).toBeGreaterThan(0);
  });

  it('contains every expected built-in type', () => {
    const ids = nodeRegistry.getAll().map((s) => s.id);
    for (const expected of [
      'agent',
      'gate',
      'manual-trigger',
      'webhook-trigger',
      'cron-trigger',
      'code-executor',
    ]) {
      expect(ids).toContain(expected);
    }
  });
});

describe('getConfigZodSchema', () => {
  it('returns a Zod schema for every registered node type', () => {
    for (const spec of nodeRegistry.getAll()) {
      // Only specs with a configSchema produce a Zod schema
      if (spec.configSchema) {
        expect(nodeRegistry.getConfigZodSchema(spec.id)).toBeDefined();
      }
    }
  });

  it('returns undefined for an unknown type', () => {
    expect(nodeRegistry.getConfigZodSchema('nonexistent')).toBeUndefined();
  });
});

describe('agent config validation', () => {
  it('valid config passes', () => {
    const schema = nodeRegistry.getConfigZodSchema('agent')!;
    const result = schema.safeParse({ agentId: 'my-agent', max_iterations: 5, output_schema: { type: 'object', properties: {} } });
    expect(result.success).toBe(true);
  });

  it('missing required agentId fails', () => {
    const schema = nodeRegistry.getConfigZodSchema('agent')!;
    const result = schema.safeParse({ max_iterations: 5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('agentId');
    }
  });

  it('config with output_schema passes', () => {
    const schema = nodeRegistry.getConfigZodSchema('agent')!;
    const result = schema.safeParse({
      agentId: 'my-agent',
      output_schema: {
        type: 'object',
        properties: { plan: { type: 'string' } },
        required: ['plan'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('extra fields are preserved via passthrough', () => {
    const schema = nodeRegistry.getConfigZodSchema('agent')!;
    const result = schema.safeParse({ agentId: 'test', output_schema: { type: 'object', properties: {} }, custom_field: 'kept' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('custom_field', 'kept');
    }
  });
});

describe('gate config validation', () => {
  it('valid config with type passes', () => {
    const schema = nodeRegistry.getConfigZodSchema('gate')!;
    const result = schema.safeParse({ type: 'manual', message: 'Approve?' });
    expect(result.success).toBe(true);
  });

  it('invalid enum value fails', () => {
    const schema = nodeRegistry.getConfigZodSchema('gate')!;
    const result = schema.safeParse({ type: 'invalid_type' });
    expect(result.success).toBe(false);
  });

  // Phase 3b retrofit: condition field now has format: 'code' for better UI.
  // The executor reads condition as a plain string — both a bare JS expression
  // and a multi-line expression (as the code editor produces) are equivalent.
  it('condition field accepts a single-line JS expression (old style)', () => {
    const schema = nodeRegistry.getConfigZodSchema('gate')!;
    const result = schema.safeParse({ type: 'conditional', condition: 'context.approved === true' });
    expect(result.success).toBe(true);
  });

  it('condition field accepts a multi-line JS expression (as code editor produces)', () => {
    const schema = nodeRegistry.getConfigZodSchema('gate')!;
    const result = schema.safeParse({
      type: 'conditional',
      condition: 'const approved = context.stages.review.latest.approved;\napproved === true',
    });
    expect(result.success).toBe(true);
  });
});

describe('webhook-trigger config validation', () => {
  // Phase 3b retrofit: secret field now has x-widget: 'secret' for masked input.
  // The field shape is still a plain string — no executor change.
  it('accepts a secret string value', () => {
    const schema = nodeRegistry.getConfigZodSchema('webhook-trigger')!;
    const result = schema.safeParse({
      secret: 'my-hmac-secret-key',
      payload_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: {} },
    });
    expect(result.success).toBe(true);
  });

  it('works without a secret (optional field)', () => {
    const schema = nodeRegistry.getConfigZodSchema('webhook-trigger')!;
    const result = schema.safeParse({
      payload_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: {} },
    });
    expect(result.success).toBe(true);
  });
});

describe('cron-trigger config validation', () => {
  it('valid schedule passes', () => {
    const schema = nodeRegistry.getConfigZodSchema('cron-trigger')!;
    const result = schema.safeParse({ schedule: '5m', output_schema: { type: 'object', properties: {} } });
    expect(result.success).toBe(true);
  });

  it('invalid schedule type fails', () => {
    const schema = nodeRegistry.getConfigZodSchema('cron-trigger')!;
    // schedule has a default of '5m', so omitting it passes;
    // providing a non-string value should fail
    const result = schema.safeParse({ schedule: 42 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasLifecycle / hasSampleEvent projections
// ---------------------------------------------------------------------------

function makeTriggerSpec(overrides: Partial<TriggerExecutor> = {}): NodeTypeSpec {
  const executor: TriggerExecutor = { type: 'trigger', ...overrides };
  return {
    id: `test-trigger-${Math.random().toString(36).slice(2)}`,
    name: 'Test Trigger',
    category: 'trigger',
    description: 'A test trigger',
    icon: 'zap',
    color: { bg: '#fff', border: '#000', text: '#000' },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    executor,
  };
}

function makeStepSpec(): NodeTypeSpec {
  const executor: StepExecutor = {
    type: 'step',
    execute: async () => ({ output: {} }),
  };
  return {
    id: `test-step-${Math.random().toString(36).slice(2)}`,
    name: 'Test Step',
    category: 'step',
    description: 'A test step',
    icon: 'box',
    color: { bg: '#fff', border: '#000', text: '#000' },
    configSchema: { type: 'object', properties: {} },
    defaultConfig: {},
    executor,
  };
}

describe('NodeTypeInfo hasLifecycle', () => {
  let reg: NodeTypeRegistry;

  beforeEach(() => {
    reg = new NodeTypeRegistry();
  });

  it('hasLifecycle === true when executor has activate()', () => {
    const spec = makeTriggerSpec({
      activate: async () => () => {},
    });
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasLifecycle).toBe(true);
  });

  it('hasLifecycle === false when trigger executor has no activate()', () => {
    const spec = makeTriggerSpec(); // no activate
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasLifecycle).toBe(false);
  });

  it('hasLifecycle === false for step node types', () => {
    const spec = makeStepSpec();
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasLifecycle).toBe(false);
  });
});

describe('NodeTypeInfo hasSampleEvent', () => {
  let reg: NodeTypeRegistry;

  beforeEach(() => {
    reg = new NodeTypeRegistry();
  });

  it('hasSampleEvent === true when executor has sampleEvent()', () => {
    const spec = makeTriggerSpec({
      sampleEvent: (_config) => ({ source: 'test' }),
    });
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasSampleEvent).toBe(true);
  });

  it('hasSampleEvent === false when trigger executor has no sampleEvent()', () => {
    const spec = makeTriggerSpec(); // no sampleEvent
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasSampleEvent).toBe(false);
  });

  it('hasSampleEvent === false for step node types', () => {
    const spec = makeStepSpec();
    reg.register(spec);
    const info = reg.getAllInfo().find((i) => i.id === spec.id)!;
    expect(info.hasSampleEvent).toBe(false);
  });
});

describe('built-in trigger lifecycle flags', () => {
  it('cron-trigger has hasLifecycle and hasSampleEvent === true', () => {
    const info = nodeRegistry.getAllInfo().find((i) => i.id === 'cron-trigger')!;
    expect(info.hasLifecycle).toBe(true);
    expect(info.hasSampleEvent).toBe(true);
  });

  it('code-trigger has hasLifecycle and hasSampleEvent === true', () => {
    const info = nodeRegistry.getAllInfo().find((i) => i.id === 'code-trigger')!;
    expect(info.hasLifecycle).toBe(true);
    expect(info.hasSampleEvent).toBe(true);
  });

  it('manual-trigger has hasLifecycle === false', () => {
    const info = nodeRegistry.getAllInfo().find((i) => i.id === 'manual-trigger')!;
    expect(info.hasLifecycle).toBe(false);
  });
});

