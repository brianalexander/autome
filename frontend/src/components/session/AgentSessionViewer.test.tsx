import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSessionViewer } from './AgentSessionViewer';
import type { StageContext } from '../../lib/api';

// Mock AcpChatPane — captures props so tests can inspect them
const mockAcpChatPaneProps: Record<string, unknown> = {};
vi.mock('../chat/AcpChatPane', () => ({
  AcpChatPane: (props: Record<string, unknown>) => {
    Object.assign(mockAcpChatPaneProps, props);
    // Render user messages from initialMessages so we can assert them
    const messages = props.initialMessages as Array<{ role: string; content?: string }> | undefined;
    return (
      <div data-testid="acp-chat-pane">
        {messages?.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} data-testid="user-bubble">
              {m.content}
            </div>
          ) : null
        )}
      </div>
    );
  },
}));

// Hold mutable return values for per-test overrides
const queryHookReturns = {
  useStagePrompt: { data: undefined as { prompt: string; iteration: number; created_at: string } | undefined },
};
const chatSegmentReturns = {
  useChatSegments: { initialMessages: undefined as Array<{ role: string; content?: string; timestamp: string; segments: Array<{ type: string; content: string }> }> | undefined },
};

// Mock all query hooks used by AgentSessionViewer
vi.mock('../../hooks/queries', () => ({
  useCancelStage: () => ({ mutate: vi.fn() }),
  useRestartStageSession: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAgent: () => ({ data: undefined }),
  useStagePrompt: () => queryHookReturns.useStagePrompt,
}));

vi.mock('../../hooks/useChatSegments', () => ({
  useChatSegments: () => chatSegmentReturns.useChatSegments,
}));

// Minimal running stage context
const runningStageContext: StageContext = {
  status: 'running',
  run_count: 1,
  runs: [
    {
      iteration: 0,
      status: 'running',
      started_at: new Date().toISOString(),
    },
  ],
};

const defaultProps = {
  instanceId: 'instance-1',
  stageId: 'stage-1',
  stageContext: runningStageContext,
  stageDef: undefined,
  onClose: vi.fn(),
};

describe('AgentSessionViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset captured props between tests
    Object.keys(mockAcpChatPaneProps).forEach(k => delete mockAcpChatPaneProps[k]);
    // Reset per-test hook return values
    queryHookReturns.useStagePrompt = { data: undefined };
    chatSegmentReturns.useChatSegments = { initialMessages: undefined };
  });

  it('renders AcpChatPane on initial mount (chat tab is default)', () => {
    render(<AgentSessionViewer {...defaultProps} />);
    expect(screen.getByTestId('acp-chat-pane')).toBeInTheDocument();
  });

  it('keeps AcpChatPane in the DOM when switching to prompt tab', () => {
    render(<AgentSessionViewer {...defaultProps} />);

    // Confirm AcpChatPane is visible initially
    const chatPane = screen.getByTestId('acp-chat-pane');
    expect(chatPane).toBeInTheDocument();

    // Click the Prompt tab
    fireEvent.click(screen.getByRole('button', { name: /prompt/i }));

    // AcpChatPane must still be in the DOM (just hidden via CSS)
    expect(screen.getByTestId('acp-chat-pane')).toBeInTheDocument();

    // The wrapper div should be hidden (display:none via Tailwind 'hidden' class)
    const wrapper = screen.getByTestId('acp-chat-pane-wrapper');
    expect(wrapper).toHaveClass('hidden');
  });

  it('keeps AcpChatPane in the DOM when switching to config tab', () => {
    render(<AgentSessionViewer {...defaultProps} />);

    // There are multiple buttons matching /config/i (tab + copy button title), so use exact text
    const configTabButton = screen.getAllByRole('button', { name: /config/i }).find(
      (btn) => btn.textContent?.trim() === 'config',
    );
    expect(configTabButton).toBeDefined();
    fireEvent.click(configTabButton!);

    expect(screen.getByTestId('acp-chat-pane')).toBeInTheDocument();
    expect(screen.getByTestId('acp-chat-pane-wrapper')).toHaveClass('hidden');
  });

  it('restores chat tab visibility when switching back from prompt', () => {
    render(<AgentSessionViewer {...defaultProps} />);

    // Switch away then back
    fireEvent.click(screen.getByRole('button', { name: /prompt/i }));
    fireEvent.click(screen.getByRole('button', { name: /chat/i }));

    const wrapper = screen.getByTestId('acp-chat-pane-wrapper');
    // Should no longer be hidden
    expect(wrapper).not.toHaveClass('hidden');
  });

  // --- Bug 2: readOnly — no input textarea in the chat pane ---
  it('passes readOnly=true to AcpChatPane so users cannot type to the agent', () => {
    render(<AgentSessionViewer {...defaultProps} />);
    expect(mockAcpChatPaneProps.readOnly).toBe(true);
  });

  it('does NOT render a textarea inside the chat pane (mock AcpChatPane has no textarea)', () => {
    render(<AgentSessionViewer {...defaultProps} />);
    // The AcpChatPane mock does not render a textarea, confirming AgentSessionViewer
    // does not add its own input either.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  // --- Bug 3: seeded prompt bubble ---
  it('prepends the rendered prompt as a user bubble when promptData is available', () => {
    queryHookReturns.useStagePrompt = {
      data: { prompt: 'Summarize the document', iteration: 0, created_at: new Date().toISOString() },
    };

    render(<AgentSessionViewer {...defaultProps} />);

    const userBubbles = screen.queryAllByTestId('user-bubble');
    expect(userBubbles.length).toBeGreaterThan(0);
    expect(userBubbles[0]).toHaveTextContent('Summarize the document');
  });

  it('does NOT duplicate the prompt bubble when the transcript already starts with it', () => {
    const promptText = 'Summarize the document';
    queryHookReturns.useStagePrompt = {
      data: { prompt: promptText, iteration: 0, created_at: new Date().toISOString() },
    };

    // useChatSegments returns a transcript that already starts with this prompt
    chatSegmentReturns.useChatSegments = {
      initialMessages: [
        {
          role: 'user',
          content: promptText,
          timestamp: new Date().toISOString(),
          segments: [{ type: 'text', content: promptText }],
        },
      ],
    };

    render(<AgentSessionViewer {...defaultProps} />);

    const userBubbles = screen.queryAllByTestId('user-bubble');
    // Should only appear once — dedup prevents a double
    expect(userBubbles).toHaveLength(1);
  });
});
