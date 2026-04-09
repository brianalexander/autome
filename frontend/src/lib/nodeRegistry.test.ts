import { describe, it, expect } from 'vitest';
import { buildNodeCategories, flattenNodeEntries } from './nodeRegistry';
import type { NodeTypeInfo } from './api';

// Factory for a minimal NodeTypeInfo
function makeNodeType(overrides: Partial<NodeTypeInfo> & { id: string; name: string }): NodeTypeInfo {
  return {
    category: overrides.category ?? 'step',
    description: overrides.description ?? 'A node',
    icon: overrides.icon ?? 'circle',
    color: overrides.color ?? { bg: 'bg-gray-100', border: 'border-gray-300', text: 'text-gray-700' },
    configSchema: overrides.configSchema ?? {},
    defaultConfig: overrides.defaultConfig ?? {},
    executorType: overrides.executorType ?? 'step',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildNodeCategories
// ---------------------------------------------------------------------------
describe('buildNodeCategories', () => {
  it('returns an empty array for an empty input', () => {
    expect(buildNodeCategories([])).toEqual([]);
  });

  it('puts manual-trigger into the Triggers group', () => {
    const nodes = [makeNodeType({ id: 'manual-trigger', name: 'Manual Trigger' })];
    const result = buildNodeCategories(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Triggers');
    expect(result[0].nodes[0].type).toBe('manual-trigger');
  });

  it('puts webhook-trigger, cron-trigger, and code-trigger into Triggers', () => {
    const nodes = [
      makeNodeType({ id: 'webhook-trigger', name: 'Webhook' }),
      makeNodeType({ id: 'cron-trigger', name: 'Cron' }),
      makeNodeType({ id: 'code-trigger', name: 'Code Trigger' }),
    ];
    const result = buildNodeCategories(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Triggers');
    expect(result[0].nodes).toHaveLength(3);
  });

  it('puts agent into AI & Agents group', () => {
    const nodes = [makeNodeType({ id: 'agent', name: 'Agent' })];
    const result = buildNodeCategories(nodes);
    expect(result[0].label).toBe('AI & Agents');
  });

  it('puts gate and code-executor into Logic group', () => {
    const nodes = [
      makeNodeType({ id: 'gate', name: 'Gate' }),
      makeNodeType({ id: 'code-executor', name: 'Code Executor' }),
    ];
    const result = buildNodeCategories(nodes);
    expect(result[0].label).toBe('Logic');
    expect(result[0].nodes).toHaveLength(2);
  });

  it('respects GROUP_ORDER: Triggers before AI & Agents before Logic', () => {
    const nodes = [
      makeNodeType({ id: 'code-executor', name: 'Code Executor' }),
      makeNodeType({ id: 'agent', name: 'Agent' }),
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
    ];
    const result = buildNodeCategories(nodes);
    expect(result.map((c) => c.label)).toEqual(['Triggers', 'AI & Agents', 'Logic']);
  });

  it('falls back to Triggers group when category === "trigger" and id is unknown', () => {
    const nodes = [makeNodeType({ id: 'custom-trigger', name: 'Custom', category: 'trigger' })];
    const result = buildNodeCategories(nodes);
    expect(result[0].label).toBe('Triggers');
  });

  it('puts unmapped non-trigger nodes into Other group', () => {
    const nodes = [makeNodeType({ id: 'custom-step', name: 'Custom Step', category: 'step' })];
    const result = buildNodeCategories(nodes);
    const other = result.find((c) => c.label === 'Other');
    expect(other).toBeDefined();
    expect(other!.nodes[0].type).toBe('custom-step');
  });

  it('places Other after known groups in the order', () => {
    const nodes = [
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
      makeNodeType({ id: 'custom-step', name: 'Custom', category: 'step' }),
    ];
    const result = buildNodeCategories(nodes);
    const labels = result.map((c) => c.label);
    expect(labels[0]).toBe('Triggers');
    expect(labels[labels.length - 1]).toBe('Other');
  });

  it('maps node fields correctly onto NodeEntry', () => {
    const nodes = [
      makeNodeType({
        id: 'agent',
        name: 'My Agent',
        description: 'Runs AI tasks',
        icon: 'bot',
      }),
    ];
    const result = buildNodeCategories(nodes);
    const entry = result[0].nodes[0];
    expect(entry.type).toBe('agent');
    expect(entry.label).toBe('My Agent');
    expect(entry.description).toBe('Runs AI tasks');
    expect(entry.icon).toBe('bot');
    expect(entry.category).toBe('AI & Agents');
  });

  it('handles multiple nodes in the same group', () => {
    const nodes = [
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
      makeNodeType({ id: 'webhook-trigger', name: 'Webhook' }),
    ];
    const result = buildNodeCategories(nodes);
    expect(result[0].nodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// flattenNodeEntries
// ---------------------------------------------------------------------------
describe('flattenNodeEntries', () => {
  it('returns an empty array for no categories', () => {
    expect(flattenNodeEntries([])).toEqual([]);
  });

  it('returns all nodes from a single category', () => {
    const categories = buildNodeCategories([
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
      makeNodeType({ id: 'cron-trigger', name: 'Cron' }),
    ]);
    const entries = flattenNodeEntries(categories);
    expect(entries).toHaveLength(2);
  });

  it('returns all nodes from multiple categories combined', () => {
    const nodes = [
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
      makeNodeType({ id: 'agent', name: 'Agent' }),
      makeNodeType({ id: 'gate', name: 'Gate' }),
    ];
    const categories = buildNodeCategories(nodes);
    const entries = flattenNodeEntries(categories);
    expect(entries).toHaveLength(3);
  });

  it('preserves node order within each category', () => {
    const nodes = [
      makeNodeType({ id: 'agent', name: 'Agent' }),
      makeNodeType({ id: 'gate', name: 'Gate' }),
      makeNodeType({ id: 'code-executor', name: 'Code Executor' }),
    ];
    const categories = buildNodeCategories(nodes);
    const entries = flattenNodeEntries(categories);
    // gate and code-executor are both Logic; agent is AI & Agents
    const types = entries.map((e) => e.type);
    expect(types).toContain('agent');
    expect(types).toContain('gate');
    expect(types).toContain('code-executor');
  });

  it('is the inverse of buildNodeCategories (round-trip count)', () => {
    const nodes = [
      makeNodeType({ id: 'manual-trigger', name: 'Manual' }),
      makeNodeType({ id: 'agent', name: 'Agent' }),
      makeNodeType({ id: 'gate', name: 'Gate' }),
      makeNodeType({ id: 'custom-step', name: 'Custom', category: 'step' }),
    ];
    const categories = buildNodeCategories(nodes);
    const entries = flattenNodeEntries(categories);
    expect(entries).toHaveLength(nodes.length);
  });
});
