import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewTemplateCard } from '../PreviewTemplateCard';
import type { StageDefinition, WorkflowDefinition } from '../../../../lib/api';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGateStage(message: string): StageDefinition {
  return {
    id: 'gate1',
    type: 'gate',
    config: { type: 'manual', message },
  } as StageDefinition;
}

const triggerStage: StageDefinition = {
  id: 'trigger',
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

const classifierStage: StageDefinition = {
  id: 'classifier',
  type: 'agent',
  config: {
    agentId: 'classifier-agent',
    output_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', title: 'Category' },
      },
    },
  },
} as StageDefinition;

const gateStageWithMessage = makeGateStage(
  'Please review: {{ trigger.subject }} — category: {{ stages.classifier.latest.category }}',
);

const definition: WorkflowDefinition = {
  id: 'wf-1',
  name: 'Test Workflow',
  stages: [triggerStage, classifierStage, gateStageWithMessage],
  edges: [
    { id: 'e1', source: 'trigger', target: 'classifier' },
    { id: 'e2', source: 'classifier', target: 'gate1' },
  ],
} as unknown as WorkflowDefinition;

const baseProps = {
  card: { kind: 'preview-template' as const, field: 'message', title: 'Message Preview' },
  stage: gateStageWithMessage,
  workflowId: 'wf-1',
  apiOrigin: 'https://example.com',
  definition,
};

// ---------------------------------------------------------------------------
// PreviewTemplateCard
// ---------------------------------------------------------------------------

describe('PreviewTemplateCard', () => {
  it('renders title', () => {
    render(<PreviewTemplateCard {...baseProps} />);
    expect(screen.getByText('Message Preview')).toBeInTheDocument();
  });

  it('renders Nunjucks template output using sampled upstream schema values', () => {
    render(<PreviewTemplateCard {...baseProps} />);
    // The mock context samples: trigger.subject = "Sample Subject", classifier.latest.category = "Sample Category"
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    const text = pre!.textContent ?? '';
    // Sampled values should be filled in
    expect(text).toContain('Sample Subject');
    expect(text).toContain('Sample Category');
  });

  it('shows rendered output without template syntax', () => {
    render(<PreviewTemplateCard {...baseProps} />);
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    // Should not show raw Nunjucks syntax
    expect(pre!.textContent).not.toContain('{{');
  });

  it('renders nothing when template is empty', () => {
    const emptyStage = makeGateStage('');
    const { container } = render(
      <PreviewTemplateCard
        {...baseProps}
        stage={emptyStage}
        card={{ kind: 'preview-template', field: 'message', title: 'Preview' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when field is missing from config', () => {
    const noMsgStage: StageDefinition = {
      id: 'gate1',
      type: 'gate',
      config: { type: 'manual' },
    } as StageDefinition;
    const { container } = render(
      <PreviewTemplateCard
        {...baseProps}
        stage={noMsgStage}
        card={{ kind: 'preview-template', field: 'message', title: 'Preview' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows red error box for malformed template', () => {
    const badStage = makeGateStage('Hello {{ unclosed');
    render(
      <PreviewTemplateCard
        {...baseProps}
        stage={badStage}
        card={{ kind: 'preview-template', field: 'message', title: 'Preview' }}
      />,
    );
    // Error state: red-tinted box with error text
    const errorBox = document.querySelector('.bg-red-50, [class*="red-950"]');
    expect(errorBox).not.toBeNull();
    // No normal pre output
    const pre = document.querySelector('pre');
    expect(pre).toBeNull();
  });

  it('works without a definition (no graph traversal)', () => {
    const simpleStage = makeGateStage('Subject: {{ trigger.prompt }}');
    render(
      <PreviewTemplateCard
        {...baseProps}
        stage={simpleStage}
        card={{ kind: 'preview-template', field: 'message', title: 'Preview' }}
        definition={undefined}
      />,
    );
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    // Fallback trigger has prompt = 'Sample prompt'
    expect(pre!.textContent).toContain('Sample prompt');
  });

  it('renders nothing for wrong card kind', () => {
    const { container } = render(
      <PreviewTemplateCard
        {...baseProps}
        card={{ kind: 'help-text', markdown: 'hello' } as never}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
