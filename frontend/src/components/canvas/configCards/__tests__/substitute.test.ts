import { describe, it, expect } from 'vitest';
import { substituteTemplate } from '../substitute';

describe('substituteTemplate', () => {
  const baseVars = {
    workflowId: 'wf-123',
    stageId: 'stage-456',
    apiOrigin: 'https://example.com',
  };

  it('substitutes {workflowId}', () => {
    expect(substituteTemplate('workflow: {workflowId}', baseVars)).toBe('workflow: wf-123');
  });

  it('substitutes {stageId}', () => {
    expect(substituteTemplate('stage: {stageId}', baseVars)).toBe('stage: stage-456');
  });

  it('substitutes {apiOrigin}', () => {
    expect(substituteTemplate('origin: {apiOrigin}', baseVars)).toBe('origin: https://example.com');
  });

  it('substitutes multiple occurrences of the same variable', () => {
    const result = substituteTemplate('{apiOrigin}/api/{workflowId} and {apiOrigin}/other', baseVars);
    expect(result).toBe('https://example.com/api/wf-123 and https://example.com/other');
  });

  it('substitutes {config.FIELD} when config is provided', () => {
    const vars = { ...baseVars, config: { secret: 'my-secret', count: 42 } };
    expect(substituteTemplate('{config.secret}', vars)).toBe('my-secret');
    expect(substituteTemplate('{config.count}', vars)).toBe('42');
  });

  it('replaces unknown config fields with empty string', () => {
    const vars = { ...baseVars, config: {} };
    expect(substituteTemplate('header: {config.missing}', vars)).toBe('header: ');
  });

  it('leaves {config.FIELD} as empty string when config is not provided', () => {
    expect(substituteTemplate('x: {config.secret}', baseVars)).toBe('x: ');
  });

  it('handles templates with no substitution variables', () => {
    expect(substituteTemplate('hello world', baseVars)).toBe('hello world');
  });

  it('handles a full URL template', () => {
    const result = substituteTemplate('{apiOrigin}/api/webhooks/{workflowId}', baseVars);
    expect(result).toBe('https://example.com/api/webhooks/wf-123');
  });
});
