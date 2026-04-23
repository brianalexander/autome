/**
 * Tests for the StageConfigForm readOnly output_schema display fix.
 *
 * Problem being tested: for nodes with readOnly output_schema (gate, review-gate,
 * prompt-trigger, cron-trigger), the stored stage.config.output_schema can be stale
 * if the spec evolved after the stage was created. The UI must:
 *
 *   1. Always read from spec.defaultConfig.output_schema for readOnly fields (not stale config).
 *   2. Resolve x-passthrough fields against the live upstream shape.
 *   3. Show the user's edited value for non-readOnly output_schemas (agent, code-executor, etc.).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageConfigForm } from './StageConfigForm';
import type { StageDefinition, WorkflowDefinition, NodeTypeInfo } from '../../lib/api';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// CodeEditor uses CodeMirror which doesn't work in jsdom.
vi.mock('./CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => (
    <div data-testid="code-editor">{value}</div>
  ),
}));

// ConfigCardRenderer — renders nothing for these tests (we're focused on SchemaForm output).
vi.mock('./ConfigCardRenderer', () => ({
  ConfigCardRenderer: () => null,
}));

// Mock useNodeTypes so we control which specs are returned.
const mockNodeTypeSpecs: NodeTypeInfo[] = [];
vi.mock('../../hooks/queries', () => ({
  useNodeTypes: () => ({ data: mockNodeTypeSpecs }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the code-editor element that contains a JSON object with a "properties" key.
 * SchemaForm renders multiple code editors (e.g. message template + output_schema json).
 * We target the output_schema one by its content shape.
 */
function findOutputSchemaEditor(): HTMLElement {
  const editors = screen.getAllByTestId('code-editor');
  const outputSchemaEditor = editors.find((el) => {
    const text = el.textContent ?? '';
    if (!text.trim().startsWith('{')) return false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return 'properties' in parsed;
    } catch {
      return false;
    }
  });
  if (!outputSchemaEditor) throw new Error('No output_schema code editor found among rendered editors');
  return outputSchemaEditor;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-test',
    name: 'Test',
    active: false,
    trigger: { provider: 'manual' },
    stages: [],
    edges: [],
    ...overrides,
  } as unknown as WorkflowDefinition;
}

/** A review-gate spec with readOnly output_schema containing x-passthrough */
const reviewGateSpec: NodeTypeInfo = {
  id: 'review-gate',
  name: 'Review Gate',
  category: 'step',
  description: 'Review gate',
  icon: 'gavel',
  color: { bg: '#fef3c7', border: '#f59e0b', text: '#d97706' },
  executorType: 'step',
  configSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', title: 'Message', format: 'template' },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        format: 'json',
        readOnly: true,
      },
    },
  },
  defaultConfig: {
    output_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approved', 'revised', 'rejected'] },
        notes: { type: 'string' },
        input: {
          'x-passthrough': 'input',
          description: 'Passthrough of upstream output.',
        },
      },
      required: ['decision', 'input'],
    },
  },
} as unknown as NodeTypeInfo;

/** An agent spec with a user-editable (non-readOnly) output_schema */
const agentSpec: NodeTypeInfo = {
  id: 'agent',
  name: 'Agent',
  category: 'step',
  description: 'Agent',
  icon: 'cpu',
  color: { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  executorType: 'step',
  configSchema: {
    type: 'object',
    properties: {
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        format: 'json',
        // No readOnly — user-editable
      },
    },
  },
  defaultConfig: {},
} as unknown as NodeTypeInfo;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StageConfigForm — readOnly output_schema display', () => {
  beforeEach(() => {
    // Reset the mock specs array before each test
    mockNodeTypeSpecs.length = 0;
  });

  it('shows resolved upstream shape in output_schema for a review-gate downstream of a trigger', () => {
    mockNodeTypeSpecs.push(reviewGateSpec);

    const triggerStage: StageDefinition = {
      id: 'trigger1',
      type: 'manual-trigger',
      config: {
        output_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', title: 'Subject' },
            amount: { type: 'number', title: 'Amount' },
          },
        },
      },
    } as StageDefinition;

    const reviewGateStage: StageDefinition = {
      id: 'gate1',
      type: 'review-gate',
      config: { message: 'Please review' },
    } as StageDefinition;

    const definition = makeWorkflow({
      stages: [triggerStage, reviewGateStage],
      edges: [{ id: 'e1', source: 'trigger1', target: 'gate1' } as unknown as WorkflowDefinition['edges'][0]],
    });

    render(
      <StageConfigForm
        stage={reviewGateStage}
        onChange={vi.fn()}
        definition={definition}
      />,
    );

    // The CodeWidget renders the resolved JSON. Find it and check its content
    // includes the upstream trigger's field names in input.properties.
    const codeEditor = findOutputSchemaEditor();
    const displayedJson = codeEditor.textContent ?? '';

    // Parsed form for cleaner assertions
    const parsed = JSON.parse(displayedJson) as Record<string, unknown>;
    const props = (parsed.properties as Record<string, unknown>) ?? {};

    // decision and notes should be present (from spec, not stale config)
    expect(props).toHaveProperty('decision');
    expect(props).toHaveProperty('notes');

    // input should be resolved to the trigger's output schema shape (not x-passthrough marker)
    const inputField = props['input'] as Record<string, unknown>;
    expect(inputField).not.toHaveProperty('x-passthrough');
    expect(inputField).toHaveProperty('type', 'object');
    const inputProps = inputField['properties'] as Record<string, unknown>;
    expect(inputProps).toHaveProperty('subject');
    expect(inputProps).toHaveProperty('amount');
  });

  it('ignores stale stage.config.output_schema for readOnly fields and uses spec defaultConfig', () => {
    mockNodeTypeSpecs.push(reviewGateSpec);

    // Stale config: missing the `notes` field that the current spec has.
    // It also has a stale x-passthrough marker in input (the config was saved before the spec added notes).
    const staleOutputSchema = {
      type: 'object',
      properties: {
        // Missing `notes` — old version of the schema before notes was added
        decision: { type: 'string' },
        input: { 'x-passthrough': 'input', description: 'Old description' },
      },
    };

    const triggerStage: StageDefinition = {
      id: 'trigger1',
      type: 'manual-trigger',
      config: {
        output_schema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      },
    } as StageDefinition;

    const reviewGateStage: StageDefinition = {
      id: 'gate1',
      type: 'review-gate',
      config: {
        message: 'Review',
        output_schema: staleOutputSchema, // stale — would be shown without the fix
      },
    } as StageDefinition;

    const definition = makeWorkflow({
      stages: [triggerStage, reviewGateStage],
      edges: [{ id: 'e1', source: 'trigger1', target: 'gate1' } as unknown as WorkflowDefinition['edges'][0]],
    });

    render(
      <StageConfigForm
        stage={reviewGateStage}
        onChange={vi.fn()}
        definition={definition}
      />,
    );

    const codeEditor = findOutputSchemaEditor();
    const parsed = JSON.parse(codeEditor.textContent ?? '') as Record<string, unknown>;
    const props = (parsed.properties as Record<string, unknown>) ?? {};

    // Should show `notes` from the CURRENT spec defaultConfig, not the stale stored schema
    expect(props).toHaveProperty('notes');

    // input should be resolved — not the raw x-passthrough marker
    const inputField = props['input'] as Record<string, unknown>;
    expect(inputField).not.toHaveProperty('x-passthrough');
    expect(inputField).toHaveProperty('type', 'object');

    // Should show upstream's `result` field
    const inputProps = inputField['properties'] as Record<string, unknown>;
    expect(inputProps).toHaveProperty('result');
  });

  it('shows no-upstream fallback when review-gate has no incoming edges', () => {
    mockNodeTypeSpecs.push(reviewGateSpec);

    const reviewGateStage: StageDefinition = {
      id: 'gate1',
      type: 'review-gate',
      config: { message: 'Review' },
    } as StageDefinition;

    // No edges — review-gate is not connected to anything
    const definition = makeWorkflow({
      stages: [reviewGateStage],
      edges: [],
    });

    render(
      <StageConfigForm
        stage={reviewGateStage}
        onChange={vi.fn()}
        definition={definition}
      />,
    );

    const codeEditor = findOutputSchemaEditor();
    const parsed = JSON.parse(codeEditor.textContent ?? '') as Record<string, unknown>;
    const props = (parsed.properties as Record<string, unknown>) ?? {};

    // input should exist — resolved to the no-upstream fallback (not x-passthrough marker)
    const inputField = props['input'] as Record<string, unknown>;
    expect(inputField).not.toHaveProperty('x-passthrough');

    // decision should still be present
    expect(props).toHaveProperty('decision');
  });

  it('shows user-edited output_schema for non-readOnly fields (agent node)', () => {
    mockNodeTypeSpecs.push(agentSpec);

    const userEditedSchema = {
      type: 'object',
      properties: {
        my_custom_field: { type: 'string', title: 'My Field' },
      },
    };

    const agentStage: StageDefinition = {
      id: 'agent1',
      type: 'agent',
      config: {
        agentId: 'my-agent',
        output_schema: userEditedSchema,
      },
    } as StageDefinition;

    const definition = makeWorkflow({
      stages: [agentStage],
      edges: [],
    });

    render(
      <StageConfigForm
        stage={agentStage}
        onChange={vi.fn()}
        definition={definition}
      />,
    );

    const codeEditor = screen.getByTestId('code-editor');
    // Agent spec has only one code field (output_schema), so getByTestId is unambiguous here
    const parsed = JSON.parse(codeEditor.textContent ?? '') as Record<string, unknown>;
    const props = (parsed.properties as Record<string, unknown>) ?? {};

    // Should show the user's custom field, not spec defaultConfig
    expect(props).toHaveProperty('my_custom_field');
  });

  it('resolves x-passthrough through a two-hop gate chain (trigger → gate1 → gate2)', () => {
    // gate1 also has x-passthrough, so gate2's input should trace back to trigger's output
    const gateSpec: NodeTypeInfo = {
      id: 'gate',
      name: 'Gate',
      category: 'step',
      description: 'Gate',
      icon: 'shield',
      color: { bg: '#fff1f2', border: '#f43f5e', text: '#e11d48' },
      executorType: 'step',
      configSchema: {
        type: 'object',
        properties: {
          output_schema: {
            type: 'object',
            title: 'Output Schema',
            format: 'json',
            readOnly: true,
          },
        },
      },
      defaultConfig: {
        output_schema: {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            input: { 'x-passthrough': 'input', description: 'Passthrough' },
          },
          required: ['approved', 'input'],
        },
      },
    } as unknown as NodeTypeInfo;

    mockNodeTypeSpecs.push(gateSpec);
    mockNodeTypeSpecs.push(reviewGateSpec);

    const triggerStage: StageDefinition = {
      id: 'trigger1',
      type: 'manual-trigger',
      config: {
        output_schema: {
          type: 'object',
          properties: {
            file_url: { type: 'string', title: 'File URL' },
          },
        },
      },
    } as StageDefinition;

    const gate1Stage: StageDefinition = {
      id: 'gate1',
      type: 'gate',
      config: {},
    } as StageDefinition;

    const gate2Stage: StageDefinition = {
      id: 'gate2',
      type: 'review-gate',
      config: { message: 'Second review' },
    } as StageDefinition;

    const definition = makeWorkflow({
      stages: [triggerStage, gate1Stage, gate2Stage],
      edges: [
        { id: 'e1', source: 'trigger1', target: 'gate1' } as unknown as WorkflowDefinition['edges'][0],
        { id: 'e2', source: 'gate1', target: 'gate2' } as unknown as WorkflowDefinition['edges'][0],
      ],
    });

    render(
      <StageConfigForm
        stage={gate2Stage}
        onChange={vi.fn()}
        definition={definition}
      />,
    );

    const codeEditor = findOutputSchemaEditor();
    const parsed = JSON.parse(codeEditor.textContent ?? '') as Record<string, unknown>;
    const props = (parsed.properties as Record<string, unknown>) ?? {};

    // gate2's input should trace back through gate1 to trigger1's output
    const inputField = props['input'] as Record<string, unknown>;
    expect(inputField).not.toHaveProperty('x-passthrough');
    expect(inputField).toHaveProperty('type', 'object');
    // gate1's resolved output has approved + input (which is trigger1's output)
    // gate2 receives gate1's full output as its input
    const inputProps = inputField['properties'] as Record<string, unknown>;
    expect(inputProps).toHaveProperty('approved');
    expect(inputProps).toHaveProperty('input');
  });
});
