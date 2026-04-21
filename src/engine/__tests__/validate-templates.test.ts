/**
 * Tests for validateWorkflowTemplates.
 *
 * Verifies that the save-time template/expression scanner correctly:
 *   - Rejects forbidden patterns (stages.*, context.stages, context.*)
 *   - Accepts allowed patterns (trigger.*, input.*, output.*, secret())
 *   - Walks into stage configs, edge configs, and other templated fields
 *   - Returns structured TemplateValidationError objects with suggestions
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflowTemplates, type TemplateValidationError } from '../validate-templates.js';
import type { WorkflowDefinition } from '../../types/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
    ...overrides,
  };
}

function hasError(errors: TemplateValidationError[], pattern: string | RegExp): boolean {
  return errors.some((e) => {
    const str = `${e.field} ${e.error} ${e.suggestion}`;
    if (typeof pattern === 'string') return str.includes(pattern);
    return pattern.test(str);
  });
}

// ---------------------------------------------------------------------------
// Nunjucks template — forbidden patterns
// ---------------------------------------------------------------------------

describe('Nunjucks template — forbidden patterns', () => {
  it('rejects {{ stages.STAGE_ID.X }} in stage config message', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: { message: 'Please review: {{ stages.draft.latest.content }}' },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'stages.draft')).toBe(true);
    // Suggestion should mention edge-based alternative
    expect(errors[0].suggestion).toMatch(/input\./);
  });

  it('rejects {{ stages["hyphenated-id"].X }} bracket notation in stage config', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate2',
            type: 'gate',
            config: { message: "Notes: {{ stages['plan-reviewer'].latest.notes }}" },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'plan-reviewer')).toBe(true);
  });

  it('rejects {{ context.* }} in stage config', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'agent1',
            type: 'agent',
            config: { message: 'Data: {{ context.trigger.prompt }}' },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, /context/)).toBe(true);
  });

  it('rejects {{ stages.X.Y }} in edge prompt_template', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'b',
            prompt_template: 'Plan: {{ stages.planner.output.plan }}',
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'stages.planner')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JS expressions — forbidden patterns
// ---------------------------------------------------------------------------

describe('JS expression — forbidden patterns', () => {
  it('rejects context.stages in gate condition', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: {
              type: 'conditional',
              condition: 'context.stages["review"].latest.approved === true',
            },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'context.stages')).toBe(true);
    expect(errors[0].suggestion).toMatch(/input\./);
  });

  it('rejects context[ bracket access in edge condition', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'b',
            condition: 'context["stages"].review.approved === true',
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'context')).toBe(true);
  });

  it('rejects bare context. access in any code field', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: {
              condition: 'context.trigger.payload.value > 0',
            },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, /context/)).toBe(true);
  });

  it('rejects multi-line JS with context.stages', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: {
              condition: 'const approved = context.stages.review.latest.approved;\napproved === true',
            },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(hasError(errors, 'context.stages')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accepted patterns
// ---------------------------------------------------------------------------

describe('accepted patterns', () => {
  it('accepts {{ input.FIELD }} in stage config', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: { message: 'Please review: {{ input.content }}' },
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts {{ trigger.FIELD }} in stage config', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: { message: 'Triggered by: {{ trigger.user }}' },
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts {{ output.FIELD }} in edge prompt_template', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'b',
            prompt_template: 'Review: {{ output.content }}',
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts {{ secret("NAME") }} in templates', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'agent1',
            type: 'agent',
            config: { message: 'Token: {{ secret("MY_TOKEN") }}' },
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts input.approved === true in condition', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: { condition: 'input.approved === true' },
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts output.decision === "approved" in edge condition', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'b',
            condition: "output.decision === 'approved'",
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts Nunjucks conditionals with input and trigger', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: {
              message:
                '{% if input.approved %}Approved by {{ trigger.user }}{% else %}Rejected: {{ input.reason }}{% endif %}',
            },
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('returns empty array for a workflow with no stages or edges', () => {
    const errors = validateWorkflowTemplates(makeWorkflow());
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Structured error shape
// ---------------------------------------------------------------------------

describe('structured error shape', () => {
  it('returns errors with field, error, and suggestion properties', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'gate1',
            type: 'gate',
            config: { message: 'Review: {{ stages.draft.latest.content }}' },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    const err = errors[0];
    expect(err).toHaveProperty('field');
    expect(err).toHaveProperty('error');
    expect(err).toHaveProperty('suggestion');
    expect(typeof err.field).toBe('string');
    expect(typeof err.error).toBe('string');
    expect(typeof err.suggestion).toBe('string');
  });

  it('field path includes stage index and stage id', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          {
            id: 'my_gate',
            type: 'gate',
            config: { message: 'Review: {{ stages.draft.latest.content }}' },
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toContain('stages[0]');
    expect(errors[0].field).toContain('my_gate');
  });

  it('field path includes edge index and edge id', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        edges: [
          {
            id: 'my_edge',
            source: 'a',
            target: 'b',
            prompt_template: 'Plan: {{ stages.planner.output.plan }}',
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toContain('edges[0]');
    expect(errors[0].field).toContain('my_edge');
  });

  it('walks deep into multiple stages and edges', () => {
    const errors = validateWorkflowTemplates(
      makeWorkflow({
        stages: [
          { id: 'g1', type: 'gate', config: { message: '{{ stages.a.latest.x }}' } },
          { id: 'g2', type: 'gate', config: { message: '{{ stages.b.latest.y }}' } },
        ],
        edges: [
          {
            id: 'e1',
            source: 'g1',
            target: 'g2',
            prompt_template: '{{ stages.g1.output.z }}',
          },
        ],
      }),
    );
    // Should catch all three violations
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
