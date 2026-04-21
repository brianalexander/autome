import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeDescriptionPopover } from './NodeDescriptionPopover';
import type { NodeTypeInfo } from '../../lib/api';

// StreamingMarkdown depends on ReactMarkdown/remark which don't run well in jsdom —
// replace with a simple passthrough for these tests.
vi.mock('../chat/StreamingMarkdown', () => ({
  StreamingMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

const baseInfo: NodeTypeInfo = {
  id: 'test-node',
  name: 'Test Node',
  category: 'step',
  description: 'Does something useful.',
  icon: 'circle',
  color: { bg: '#fff', border: '#ccc', text: '#000' },
  configSchema: {},
  defaultConfig: {},
  executorType: 'step',
};

describe('NodeDescriptionPopover', () => {
  it('renders the info button', () => {
    render(<NodeDescriptionPopover nodeTypeInfo={baseInfo} />);
    expect(screen.getByRole('button', { name: /node description/i })).toBeInTheDocument();
  });

  it('is disabled (pointer-events:none) when both description and help cards are empty', () => {
    const info: NodeTypeInfo = { ...baseInfo, description: '', configCards: [] };
    render(<NodeDescriptionPopover nodeTypeInfo={info} />);
    const btn = screen.getByRole('button', { name: /node description/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No description');
  });

  it('is enabled when description is present', () => {
    render(<NodeDescriptionPopover nodeTypeInfo={baseInfo} />);
    const btn = screen.getByRole('button', { name: /node description/i });
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Node description');
  });

  it('is enabled when only help-text cards are present', () => {
    const info: NodeTypeInfo = {
      ...baseInfo,
      description: '',
      configCards: [{ kind: 'help-text', title: 'Tip', markdown: 'Some tip text.' }],
    };
    render(<NodeDescriptionPopover nodeTypeInfo={info} />);
    const btn = screen.getByRole('button', { name: /node description/i });
    expect(btn).not.toBeDisabled();
  });

  it('opens popover on click and shows description', () => {
    render(<NodeDescriptionPopover nodeTypeInfo={baseInfo} />);
    fireEvent.click(screen.getByRole('button', { name: /node description/i }));
    expect(screen.getByText('Does something useful.')).toBeInTheDocument();
  });

  it('aggregates help-text cards and renders their markdown', () => {
    const info: NodeTypeInfo = {
      ...baseInfo,
      description: '',
      configCards: [
        { kind: 'help-text', title: 'How it works', markdown: 'First card content.' },
        { kind: 'help-text', markdown: 'Second card content.' },
      ],
    };
    render(<NodeDescriptionPopover nodeTypeInfo={info} />);
    fireEvent.click(screen.getByRole('button', { name: /node description/i }));
    expect(screen.getByText(/First card content\./)).toBeInTheDocument();
    expect(screen.getByText(/Second card content\./)).toBeInTheDocument();
  });

  it('shows both description and help-text cards when both present', () => {
    const info: NodeTypeInfo = {
      ...baseInfo,
      description: 'The node description.',
      configCards: [{ kind: 'help-text', markdown: 'Help card text.' }],
    };
    render(<NodeDescriptionPopover nodeTypeInfo={info} />);
    fireEvent.click(screen.getByRole('button', { name: /node description/i }));
    expect(screen.getByText('The node description.')).toBeInTheDocument();
    expect(screen.getByText(/Help card text\./)).toBeInTheDocument();
  });

  it('ignores non-help-text cards when aggregating', () => {
    const info: NodeTypeInfo = {
      ...baseInfo,
      description: '',
      configCards: [
        { kind: 'copy-url', title: 'URL', urlTemplate: 'https://example.com' },
        { kind: 'help-text', markdown: 'Only this appears.' },
      ],
    };
    render(<NodeDescriptionPopover nodeTypeInfo={info} />);
    fireEvent.click(screen.getByRole('button', { name: /node description/i }));
    expect(screen.getByText(/Only this appears\./)).toBeInTheDocument();
  });

  it('closes the popover on outside click', () => {
    render(
      <div>
        <NodeDescriptionPopover nodeTypeInfo={baseInfo} />
        <div data-testid="outside">Outside</div>
      </div>,
    );
    // Open
    fireEvent.click(screen.getByRole('button', { name: /node description/i }));
    expect(screen.getByText('Does something useful.')).toBeInTheDocument();
    // Click outside
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Does something useful.')).not.toBeInTheDocument();
  });

  it('toggles closed on second click', () => {
    render(<NodeDescriptionPopover nodeTypeInfo={baseInfo} />);
    const btn = screen.getByRole('button', { name: /node description/i });
    fireEvent.click(btn);
    expect(screen.getByText('Does something useful.')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText('Does something useful.')).not.toBeInTheDocument();
  });
});
