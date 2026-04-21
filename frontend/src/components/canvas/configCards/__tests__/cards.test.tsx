import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpTextCard } from '../HelpTextCard';
import { CopyUrlCard } from '../CopyUrlCard';
import { CurlSnippetCard } from '../CurlSnippetCard';
import { CycleBehaviorCard } from '../CycleBehaviorCard';
import type { StageDefinition, WorkflowDefinition } from '../../../../lib/api';

const mockStage: StageDefinition = {
  id: 'stage-1',
  type: 'agent',
  config: { agentId: 'my-agent' },
} as StageDefinition;

const mockDef: WorkflowDefinition = {
  id: 'wf-abc',
  name: 'Test Workflow',
  stages: [mockStage],
  edges: [],
} as unknown as WorkflowDefinition;

const baseProps = {
  stage: mockStage,
  workflowId: 'wf-abc',
  apiOrigin: 'https://example.com',
  definition: mockDef,
};

// ---------------------------------------------------------------------------
// HelpTextCard — now a no-op; content surfaced via NodeDescriptionPopover
// ---------------------------------------------------------------------------
describe('HelpTextCard', () => {
  it('renders null for help-text (content moved to info icon popover)', () => {
    const { container } = render(
      <HelpTextCard
        {...baseProps}
        card={{ kind: 'help-text', title: 'How it works', markdown: 'Some explanation here.' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders null regardless of card content', () => {
    const { container } = render(
      <HelpTextCard
        {...baseProps}
        card={{ kind: 'help-text', markdown: 'Access via `{{ output.field }}`' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders null for wrong card kind too (type guard still works)', () => {
    const { container } = render(
      <HelpTextCard
        {...baseProps}
        card={{ kind: 'copy-url', title: 'URL', urlTemplate: '{apiOrigin}/test' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CopyUrlCard
// ---------------------------------------------------------------------------
describe('CopyUrlCard', () => {
  it('renders the URL label and substituted URL', () => {
    render(
      <CopyUrlCard
        {...baseProps}
        card={{ kind: 'copy-url', title: 'Webhook URL', urlTemplate: '{apiOrigin}/api/webhooks/{workflowId}' }}
      />,
    );
    expect(screen.getByText('https://example.com/api/webhooks/wf-abc')).toBeInTheDocument();
  });

  it('renders description if provided', () => {
    render(
      <CopyUrlCard
        {...baseProps}
        card={{ kind: 'copy-url', title: 'URL', urlTemplate: '{apiOrigin}', description: 'Copy this URL' }}
      />,
    );
    expect(screen.getByText('Copy this URL')).toBeInTheDocument();
  });

  it('copies URL to clipboard on button click', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <CopyUrlCard
        {...baseProps}
        card={{ kind: 'copy-url', title: 'URL', urlTemplate: '{apiOrigin}/test' }}
      />,
    );
    fireEvent.click(screen.getByText('Copy'));
    expect(writeText).toHaveBeenCalledWith('https://example.com/test');
  });
});

// ---------------------------------------------------------------------------
// CurlSnippetCard
// ---------------------------------------------------------------------------
describe('CurlSnippetCard', () => {
  it('renders title', () => {
    render(
      <CurlSnippetCard
        {...baseProps}
        card={{ kind: 'curl-snippet', title: 'Usage', template: 'Some prose text.' }}
      />,
    );
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('renders prose segments', () => {
    render(
      <CurlSnippetCard
        {...baseProps}
        card={{ kind: 'curl-snippet', title: 'T', template: 'This is prose text.' }}
      />,
    );
    expect(screen.getByText(/This is prose text/)).toBeInTheDocument();
  });

  it('renders code block segments inside a <pre>', () => {
    render(
      <CurlSnippetCard
        {...baseProps}
        card={{
          kind: 'curl-snippet',
          title: 'T',
          template: '```\ncurl -X POST https://example.com\n```',
        }}
      />,
    );
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('curl -X POST https://example.com');
  });

  it('substitutes {apiOrigin} inside a code block', () => {
    render(
      <CurlSnippetCard
        {...baseProps}
        card={{
          kind: 'curl-snippet',
          title: 'T',
          template: '```\ncurl {apiOrigin}/api\n```',
        }}
      />,
    );
    expect(document.querySelector('pre')?.textContent).toContain('https://example.com/api');
  });
});

// ---------------------------------------------------------------------------
// CycleBehaviorCard
// ---------------------------------------------------------------------------
describe('CycleBehaviorCard', () => {
  const cycleStage: StageDefinition = {
    id: 'stage-cycle',
    type: 'agent',
    config: { cycle_behavior: 'fresh' },
  } as StageDefinition;

  const cycleDefinition: WorkflowDefinition = {
    id: 'wf-cycle',
    name: 'Cycle Workflow',
    stages: [cycleStage],
    edges: [
      // stage-cycle → stage-other → stage-cycle (forms a cycle)
      { id: 'e1', source: 'stage-cycle', target: 'stage-other' },
      { id: 'e2', source: 'stage-other', target: 'stage-cycle' },
    ],
  } as unknown as WorkflowDefinition;

  it('renders when stage is in a cycle', () => {
    render(
      <CycleBehaviorCard
        card={{ kind: 'cycle-behavior' }}
        stage={cycleStage}
        workflowId="wf-cycle"
        apiOrigin="https://example.com"
        definition={cycleDefinition}
      />,
    );
    expect(screen.getByText(/Cycle Behavior/)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('does not render when stage is NOT in a cycle', () => {
    const noCycleDefinition: WorkflowDefinition = {
      ...cycleDefinition,
      edges: [],
    } as unknown as WorkflowDefinition;
    const { container } = render(
      <CycleBehaviorCard
        card={{ kind: 'cycle-behavior' }}
        stage={cycleStage}
        workflowId="wf-cycle"
        apiOrigin="https://example.com"
        definition={noCycleDefinition}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not render without definition', () => {
    const { container } = render(
      <CycleBehaviorCard
        card={{ kind: 'cycle-behavior' }}
        stage={cycleStage}
        workflowId="wf-cycle"
        apiOrigin="https://example.com"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('calls onConfigChange when select changes', () => {
    const onConfigChange = vi.fn();
    render(
      <CycleBehaviorCard
        card={{ kind: 'cycle-behavior' }}
        stage={cycleStage}
        workflowId="wf-cycle"
        apiOrigin="https://example.com"
        definition={cycleDefinition}
        onConfigChange={onConfigChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'continue' } });
    expect(onConfigChange).toHaveBeenCalledWith('config.cycle_behavior', 'continue');
  });
});
