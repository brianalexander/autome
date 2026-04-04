import { describe, it, expect, beforeAll } from 'vitest';
import { validateStageConfig, validateAllStagesConfig } from '../validation.js';
import { initializeRegistry } from '../../../nodes/registry.js';

beforeAll(async () => {
  await initializeRegistry();
});

describe('validateStageConfig', () => {
  it('valid agent config returns no errors', () => {
    const errors = validateStageConfig('agent', { agentId: 'reviewer', output_schema: { type: 'object', properties: {} } });
    expect(errors).toEqual([]);
  });

  it('missing required field returns errors mentioning the field name', () => {
    const errors = validateStageConfig('agent', { max_iterations: 5 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('agentId');
  });

  it('unknown node type returns an error message', () => {
    const errors = validateStageConfig('nonexistent', { foo: 'bar' });
    expect(errors).toEqual(['Unknown node type "nonexistent"']);
  });

  it('gate with invalid enum value returns errors', () => {
    const errors = validateStageConfig('gate', { type: 'invalid' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('valid gate config returns no errors', () => {
    const errors = validateStageConfig('gate', { type: 'manual' });
    expect(errors).toEqual([]);
  });

  it('extra fields pass through without being rejected', () => {
    const errors = validateStageConfig('agent', { agentId: 'test', output_schema: { type: 'object', properties: {} }, unknown_field: true });
    expect(errors).toEqual([]);
  });
});

describe('validateAllStagesConfig', () => {
  it('skips trigger stages and passes valid non-trigger stages', () => {
    const errors = validateAllStagesConfig([
      { type: 'manual-trigger', config: {} }, // trigger — skipped
      { type: 'agent', config: { agentId: 'test', output_schema: { type: 'object', properties: {} } } }, // valid step
    ]);
    expect(errors).toEqual([]);
  });

  it('catches validation errors in non-trigger stages', () => {
    const errors = validateAllStagesConfig([
      { type: 'agent', config: {} }, // missing required agentId
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns no errors for an empty stages array', () => {
    const errors = validateAllStagesConfig([]);
    expect(errors).toEqual([]);
  });

  it('skips stages without a config', () => {
    const errors = validateAllStagesConfig([
      { type: 'agent' } as { type: string; config?: Record<string, unknown> },
    ]);
    expect(errors).toEqual([]);
  });
});
