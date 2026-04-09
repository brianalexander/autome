import { describe, it, expect, beforeAll } from 'vitest';
import { nodeRegistry, initializeRegistry } from '../registry.js';

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

