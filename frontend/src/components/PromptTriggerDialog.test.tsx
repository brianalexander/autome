import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptTriggerDialog } from './PromptTriggerDialog';

describe('PromptTriggerDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={false}
        onClose={vi.fn()}
        onTrigger={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders with workflow name when open', () => {
    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={vi.fn()}
        onTrigger={vi.fn()}
      />,
    );
    expect(screen.getByText('Run: My Workflow')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What would you like this workflow to do?')).toBeInTheDocument();
  });

  it('disables Run button when textarea is empty', () => {
    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={vi.fn()}
        onTrigger={vi.fn()}
      />,
    );
    const runButton = screen.getByRole('button', { name: 'Run' });
    expect(runButton).toBeDisabled();
  });

  it('enables Run button and calls onTrigger with prompt payload', async () => {
    const onTrigger = vi.fn();
    const user = userEvent.setup();

    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={vi.fn()}
        onTrigger={onTrigger}
      />,
    );

    const textarea = screen.getByPlaceholderText('What would you like this workflow to do?');
    await user.type(textarea, 'Summarize this article');

    const runButton = screen.getByRole('button', { name: 'Run' });
    expect(runButton).not.toBeDisabled();

    await user.click(runButton);

    expect(onTrigger).toHaveBeenCalledWith({
      prompt: 'Summarize this article',
      attachments: [],
    });
  });

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={onClose}
        onTrigger={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('submits on Cmd+Enter', async () => {
    const onTrigger = vi.fn();
    const user = userEvent.setup();

    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={vi.fn()}
        onTrigger={onTrigger}
      />,
    );

    const textarea = screen.getByPlaceholderText('What would you like this workflow to do?');
    await user.type(textarea, 'Hello{Meta>}{Enter}{/Meta}');

    expect(onTrigger).toHaveBeenCalledWith({
      prompt: 'Hello',
      attachments: [],
    });
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();

    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={onClose}
        onTrigger={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText('What would you like this workflow to do?');
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('shows Starting... when isPending', () => {
    render(
      <PromptTriggerDialog
        workflowName="My Workflow"
        isOpen={true}
        onClose={vi.fn()}
        onTrigger={vi.fn()}
        isPending={true}
      />,
    );
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeInTheDocument();
  });
});
