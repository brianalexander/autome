import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorkflowContextParts } from '../internal-author.js';
import { nodeRegistry } from '../../../nodes/registry.js';
import { allBuiltinSpecs } from '../../../nodes/builtin/index.js';
import type { WorkflowDefinition } from '../../../schemas/pipeline.js';

beforeAll(() => {
  for (const spec of allBuiltinSpecs) {
    try {
      nodeRegistry.register(spec);
    } catch {
      // Already registered from a prior test file — safe to ignore
    }
  }
});

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test Workflow',
    active: false,
    trigger: { provider: 'manual' },
    stages: [
      { id: 'trigger', type: 'manual-trigger' },
      { id: 'step_a', type: 'agent', config: { agentId: 'my-agent' } },
      { id: 'step_b', type: 'agent', config: { agentId: 'other-agent' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'step_a', prompt_template: 'Do something with {{ output.value }}' },
      { id: 'e2', source: 'step_a', target: 'step_b', prompt_template: 'Now process {{ output.result }}' },
    ],
    ...overrides,
  };
}

describe('buildWorkflowContextParts — template scope enforcement', () => {
  it('never mentions stages. in the output (regression gate for cross-stage reach-back)', () => {
    const parts = buildWorkflowContextParts(makeWorkflow());
    const joined = parts.join('\n');
    expect(joined).not.toMatch(/stages\./);
  });

  it('includes {{ output.<field> }} template var hints on edges', () => {
    const parts = buildWorkflowContextParts(makeWorkflow());
    const joined = parts.join('\n');
    expect(joined).toContain('{{ output.<field> }}');
  });

  it('does not expose cross-stage reach-back even when the workflow has many stages', () => {
    const workflow = makeWorkflow({
      stages: [
        { id: 'trigger', type: 'manual-trigger' },
        { id: 'stage_one', type: 'agent', config: { agentId: 'agent-1' } },
        { id: 'stage_two', type: 'agent', config: { agentId: 'agent-2' } },
        { id: 'stage_three', type: 'agent', config: { agentId: 'agent-3' } },
        { id: 'stage_four', type: 'agent', config: { agentId: 'agent-4' } },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'stage_one' },
        { id: 'e2', source: 'stage_one', target: 'stage_two' },
        { id: 'e3', source: 'stage_two', target: 'stage_three' },
        { id: 'e4', source: 'stage_three', target: 'stage_four' },
      ],
    });
    const joined = buildWorkflowContextParts(workflow).join('\n');
    expect(joined).not.toMatch(/stages\./);
  });

  it('lists all stages and edges in the output', () => {
    const parts = buildWorkflowContextParts(makeWorkflow());
    const joined = parts.join('\n');
    expect(joined).toContain('step_a');
    expect(joined).toContain('step_b');
    expect(joined).toContain('trigger -> step_a');
    expect(joined).toContain('step_a -> step_b');
  });
});
