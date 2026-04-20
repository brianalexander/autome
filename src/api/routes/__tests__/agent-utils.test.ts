import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEmitter, type AcpClientEvents } from '../../../acp/events.js';
import { wireAcpEvents } from '../agent-utils.js';
import { OrchestratorDB } from '../../../db/database.js';

// ---------------------------------------------------------------------------
// Mock the broadcast helper so tests never touch WebSocket state
// ---------------------------------------------------------------------------

vi.mock('../../websocket.js', () => ({
  broadcast: vi.fn(),
}));

import { broadcast } from '../../websocket.js';
const mockBroadcast = vi.mocked(broadcast);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AcpClient-like object that we can emit events on directly */
function makeClient() {
  return new TypedEmitter<AcpClientEvents>();
}

/** Shared opts for wireAcpEvents — override as needed */
const baseOpts = {
  instanceId: 'inst-1',
  stageId: 'stage-1',
  iteration: 0,
  eventPrefix: 'agent' as const,
  filterPayload: { instanceId: 'inst-1', stageId: 'stage-1' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireAcpEvents — synchronous DB persistence', () => {
  let db: OrchestratorDB;

  beforeEach(() => {
    db = new OrchestratorDB(':memory:');
    vi.spyOn(db, 'appendToLastTextSegment');
    vi.spyOn(db, 'sweepToolCallStatuses').mockReturnValue(0);
    vi.clearAllMocks();
  });

  it('persists every chunk immediately — two chunks produce two DB calls', () => {
    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'text', text: 'Hello' });
    client.emit('agent_message_chunk', { type: 'text', text: ' world' });

    expect(db.appendToLastTextSegment).toHaveBeenCalledTimes(2);
    expect(db.appendToLastTextSegment).toHaveBeenNthCalledWith(
      1, 'inst-1', 'stage-1', 0, 'Hello',
    );
    expect(db.appendToLastTextSegment).toHaveBeenNthCalledWith(
      2, 'inst-1', 'stage-1', 0, ' world',
    );
  });

  it('persists a single lone chunk without waiting for a follow-up', () => {
    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'text', text: 'Only chunk' });

    // Synchronous — no setImmediate needed
    expect(db.appendToLastTextSegment).toHaveBeenCalledTimes(1);
    expect(db.appendToLastTextSegment).toHaveBeenCalledWith(
      'inst-1', 'stage-1', 0, 'Only chunk',
    );
  });

  it('does not persist when chunk has no text', () => {
    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'tool_use' });

    expect(db.appendToLastTextSegment).not.toHaveBeenCalled();
  });

  it('sweep does NOT fire when consecutive text chunks arrive (no tool in between)', () => {
    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'text', text: 'Chunk A' });
    client.emit('agent_message_chunk', { type: 'text', text: 'Chunk B' });

    // sweepToolCallStatuses should not be called from appendTextChunk's sweep path
    // (it is only called from there when the previous segment was a tool segment)
    expect(db.sweepToolCallStatuses).not.toHaveBeenCalled();
  });

  it('sweep fires on text chunk that follows a tool segment', () => {
    const swept = vi.spyOn(db, 'sweepToolCallStatuses').mockReturnValue(1);
    vi.spyOn(db, 'appendSegment');
    vi.spyOn(db, 'upsertToolCall').mockImplementation(() => {});

    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    // First: a text chunk (opens a text segment)
    client.emit('agent_message_chunk', { type: 'text', text: 'Before tool' });

    // Then: a tool_call (opens a tool segment)
    client.emit('tool_call', {
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'bash',
      status: 'in_progress',
    });

    // Now: another text chunk — this should trigger the sweep because last segment is 'tool'
    client.emit('agent_message_chunk', { type: 'text', text: 'After tool' });

    // sweepToolCallStatuses called once from appendTextChunk sweep path
    expect(swept).toHaveBeenCalledWith('inst-1', 'stage-1', 0, ['in_progress', 'pending'], 'completed');

    // And the sweep broadcast fires
    expect(mockBroadcast).toHaveBeenCalledWith(
      'agent:tools_swept',
      expect.objectContaining({ toStatus: 'completed' }),
      undefined,
    );
  });

  it('sweep does NOT broadcast when sweepToolCallStatuses returns 0', () => {
    vi.spyOn(db, 'sweepToolCallStatuses').mockReturnValue(0);
    vi.spyOn(db, 'appendSegment');
    vi.spyOn(db, 'upsertToolCall').mockImplementation(() => {});

    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'text', text: 'Before tool' });
    client.emit('tool_call', { toolCallId: 'tc-2', status: 'pending' });
    client.emit('agent_message_chunk', { type: 'text', text: 'After tool' });

    expect(mockBroadcast).not.toHaveBeenCalledWith(
      'agent:tools_swept',
      expect.anything(),
      expect.anything(),
    );
  });

  it('turn_end sweeps remaining tool statuses without flushing a pending text buffer', () => {
    const swept = vi.spyOn(db, 'sweepToolCallStatuses').mockReturnValue(0);

    const client = makeClient();
    wireAcpEvents(client as any, db, baseOpts);

    client.emit('agent_message_chunk', { type: 'text', text: 'Some text' });
    // Confirm already persisted synchronously
    expect(db.appendToLastTextSegment).toHaveBeenCalledTimes(1);

    client.emit('turn_end', { stopReason: 'end_turn' });

    // turn_end sweeps tool statuses unconditionally
    expect(swept).toHaveBeenCalledWith('inst-1', 'stage-1', 0, ['in_progress', 'pending'], 'completed');
    // No extra appendToLastTextSegment calls from turn_end (nothing to flush)
    expect(db.appendToLastTextSegment).toHaveBeenCalledTimes(1);
  });
});
