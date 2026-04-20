import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSessionViewer } from './AgentSessionViewer';
import type { StageContext } from '../../lib/api';

// Mock AcpChatPane — avoids pulling in WebSocket/query deps
vi.mock('../chat/AcpChatPane', () => ({
  AcpChatPane: () => <div data-testid="acp-chat-pane">Chat Pane</div>,
}));

// Mock all query hooks used by AgentSessionViewer
vi.mock('../../hooks/queries', () => ({
  useCancelStage: () => ({ mutate: vi.fn() }),
  useInjectMessage: () => ({ mutate: vi.fn() }),
  useRestartStageSession: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAgent: () => ({ data: undefined }),
  useStagePrompt: () => ({ data: undefined }),
}));

vi.mock('../../hooks/useChatSegments', () => ({
  useChatSegments: () => ({ initialMessages: undefined }),
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
});
