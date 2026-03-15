import { describe, it, expect } from 'vitest';
import { buildAgentPrompt } from '../context-resolver.js';
import type { WorkflowContext } from '../../restate/pipeline-workflow.js';
import type { StageDefinition, EdgeDefinition, WorkflowDefinition } from '../../types/workflow.js';

// --- Shared fixture ---

const baseContext: WorkflowContext = {
  trigger: {
    prompt: 'Fix the bug',
    payload: { key: 'PROJ-123', title: 'Fix the bug' },
  },
  stages: {
    planner: {
      status: 'completed',
      run_count: 1,
      runs: [
        {
          iteration: 1,
          started_at: '2024-01-01T00:00:00.000Z',
          status: 'completed',
          output: { plan: 'Step 1: Do the thing' },
        },
      ],
      latest: { plan: 'Step 1: Do the thing' },
    },
    'plan-reviewer': {
      status: 'completed',
      run_count: 1,
      runs: [
        {
          iteration: 1,
          started_at: '2024-01-01T00:00:00.000Z',
          status: 'completed',
          output: { approved: true, feedback: 'Looks good' },
        },
      ],
      latest: { approved: true, feedback: 'Looks good' },
    },
    'code-gen': {
      status: 'pending',
      run_count: 0,
      runs: [],
      latest: undefined,
    },
  },
};

// --- buildAgentPrompt basics ---

describe('buildAgentPrompt', () => {
  const agentStage: StageDefinition = {
    id: 'code-gen',
    type: 'agent',
    config: {
      agentId: 'code-generator',
      max_iterations: 3,
    },
  };

  it('includes agentId in the preamble', () => {
    const result = buildAgentPrompt(agentStage, baseContext, 1);
    expect(result).toContain('Agent: code-generator');
  });

  it('includes additional_prompt from overrides when set', () => {
    const stageWithOverride: StageDefinition = {
      ...agentStage,
      config: {
        ...(agentStage.config as any),
        overrides: { additional_prompt: 'Focus on TypeScript.' },
      },
    };
    const result = buildAgentPrompt(stageWithOverride, baseContext, 1);
    expect(result).toContain('Additional instructions: Focus on TypeScript.');
  });

  it('omits additional instructions line when no override prompt', () => {
    const result = buildAgentPrompt(agentStage, baseContext, 1);
    expect(result).not.toContain('Additional instructions:');
  });

  it('falls back to JSON trigger payload when no incoming edge', () => {
    const result = buildAgentPrompt(agentStage, baseContext, 1);
    expect(result).toContain('"prompt": "Fix the bug"');
  });

  it('does NOT include iteration info on first iteration', () => {
    const result = buildAgentPrompt(agentStage, baseContext, 1);
    expect(result).not.toMatch(/This is iteration/);
  });

  it('includes iteration info when iteration > 1', () => {
    const result = buildAgentPrompt(agentStage, baseContext, 2);
    expect(result).toContain('This is iteration 2 of max 3.');
  });

  it('omits "of max N" when max_iterations is not set', () => {
    const stageNoMax: StageDefinition = {
      ...agentStage,
      config: { ...(agentStage.config as any), max_iterations: undefined },
    };
    const result = buildAgentPrompt(stageNoMax, baseContext, 2);
    expect(result).toContain('This is iteration 2.');
    expect(result).not.toContain('of max');
  });
});

// --- Template resolution ---

describe('edge template resolution', () => {
  const codeGenStage: StageDefinition = {
    id: 'code-gen',
    type: 'agent',
    config: { agentId: 'code-generator' },
  };

  it('resolves {{ output.field }} from source stage output', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'plan-reviewer',
      target: 'code-gen',
      prompt_template: 'Approved: {{ output.approved }}',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { approved: true, feedback: 'Looks good' },
    });
    expect(result).toContain('Approved: true');
  });

  it('resolves {{ stages.planner.output.plan }} for cross-stage reference', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'plan-reviewer',
      target: 'code-gen',
      prompt_template: 'Plan:\n{{ stages.planner.output.plan }}',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { approved: true },
    });
    expect(result).toContain('Plan:\nStep 1: Do the thing');
  });

  it('resolves bracket notation for hyphenated stage IDs', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'planner',
      target: 'code-gen',
      prompt_template: "Feedback: {{ stages['plan-reviewer'].output.feedback }}",
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { plan: 'some plan' },
    });
    expect(result).toContain('Feedback: Looks good');
  });

  it('resolves {{ trigger.field }} for trigger payload access', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'planner',
      target: 'code-gen',
      prompt_template: 'Task: {{ trigger.prompt }}',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: {},
    });
    expect(result).toContain('Task: Fix the bug');
  });

  it('renders empty string for missing paths', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'planner',
      target: 'code-gen',
      prompt_template: 'Value: [{{ stages.nonexistent.output.field }}]',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: {},
    });
    expect(result).toContain('Value: []');
  });

  it('handles conditional blocks with {% if %}', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'plan-reviewer',
      target: 'code-gen',
      prompt_template: '{% if output.approved %}Go ahead{% endif %}',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { approved: true },
    });
    expect(result).toContain('Go ahead');
  });

  it('excludes conditional body when falsy', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'plan-reviewer',
      target: 'code-gen',
      prompt_template: 'Start{% if output.approved %} (approved){% endif %}.',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { approved: false },
    });
    expect(result).toContain('Start.');
    expect(result).not.toContain('approved');
  });

  it('JSON-stringifies object values', () => {
    const edge: EdgeDefinition = {
      id: 'e1',
      source: 'planner',
      target: 'code-gen',
      prompt_template: 'Output: {{ output.data }}',
    };

    const result = buildAgentPrompt(codeGenStage, baseContext, 1, {
      incomingEdge: edge,
      sourceOutput: { data: { a: 1, b: 2 } },
    });
    expect(result).toContain('"a": 1');
    expect(result).toContain('"b": 2');
  });
});

// --- Fan-in / mergedInputs ---

describe('fan-in mergedInputs', () => {
  const fanInStage: StageDefinition = {
    id: 'merge-stage',
    type: 'agent',
    config: { agentId: 'merger' },
  };

  const fanInContext: WorkflowContext = {
    trigger: { prompt: 'run' },
    stages: {
      'branch-a': { status: 'completed', run_count: 1, runs: [], latest: { result: 'A done' } },
      'branch-b': { status: 'completed', run_count: 1, runs: [], latest: { score: 42 } },
      'merge-stage': { status: 'pending', run_count: 0, runs: [] },
    },
  };

  const mergedInputs = {
    'branch-a': { result: 'A done' },
    'branch-b': { score: 42 },
  };

  it('resolves {{ sourceOutputs.branch-a.result }} via bracket notation', () => {
    const edge: EdgeDefinition = {
      id: 'e-merge',
      source: 'branch-a',
      target: 'merge-stage',
      prompt_template:
        "A result: {{ sourceOutputs['branch-a'].result }}, B score: {{ sourceOutputs['branch-b'].score }}",
    } as any;

    const result = buildAgentPrompt(fanInStage, fanInContext, 1, {
      incomingEdge: edge,
      mergedInputs,
    });
    expect(result).toContain('A result: A done');
    expect(result).toContain('B score: 42');
  });

  it('falls back to JSON-stringified merged map when no edge template', () => {
    const result = buildAgentPrompt(fanInStage, fanInContext, 1, {
      mergedInputs,
    });
    expect(result).toContain('"branch-a"');
    expect(result).toContain('"result": "A done"');
    expect(result).toContain('"branch-b"');
    expect(result).toContain('"score": 42');
  });

  it('exposes merged map via {{ output }} dot-path in template', () => {
    const edge: EdgeDefinition = {
      id: 'e-merge',
      source: 'branch-a',
      target: 'merge-stage',
      prompt_template: "B score: {{ output['branch-b'].score }}",
    } as any;

    const result = buildAgentPrompt(fanInStage, fanInContext, 1, {
      incomingEdge: edge,
      mergedInputs,
    });
    expect(result).toContain('B score: 42');
  });
});

// --- Output requirements injection ---

describe('output requirements', () => {
  const plannerStage: StageDefinition = {
    id: 'planner',
    type: 'agent',
    config: { agentId: 'planner' },
  };

  const definition: WorkflowDefinition = {
    id: 'wf-1',
    name: 'Test',
    active: false,
    trigger: { provider: 'manual' },
    stages: [plannerStage],
    edges: [
      {
        id: 'e1',
        source: 'planner',
        target: 'plan-reviewer',
        prompt_template: 'Review: {{ output.plan }}',
      },
    ],
  };

  it('detects {{ output.field }} references in downstream prompt_template', () => {
    const result = buildAgentPrompt(plannerStage, baseContext, 1, { definition });
    expect(result).toContain('MUST include these fields');
    expect(result).toContain('- plan');
  });

  it('detects multiple {{ output.field }} references in downstream templates', () => {
    const defWithTemplate: WorkflowDefinition = {
      ...definition,
      edges: [
        {
          id: 'e1',
          source: 'planner',
          target: 'plan-reviewer',
          prompt_template: '{{ output.summary }}\n{{ output.plan }}',
        },
      ],
    };
    const result = buildAgentPrompt(plannerStage, baseContext, 1, { definition: defWithTemplate });
    expect(result).toContain('- plan');
    expect(result).toContain('- summary');
  });
});
