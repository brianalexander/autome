import type { SegmentRecord } from './api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  segments?: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }>;
  toolCalls?: Array<{
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: string;
    rawOutput?: string;
  }>;
}

/**
 * Convert an ordered list of SegmentRecords into grouped ChatMessages.
 * Segments of type 'user' become user messages; 'text' and 'tool' segments
 * are grouped into assistant messages. A role change flushes the current message.
 */
export function segmentsToMessages(segments: SegmentRecord[]): ChatMessage[] | undefined {
  if (!segments?.length) return undefined;

  const messages: ChatMessage[] = [];

  let currentRole: 'user' | 'assistant' | null = null;
  let currentSegments: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }> = [];
  let currentToolCalls: NonNullable<ChatMessage['toolCalls']> = [];
  let currentTimestamp = '';

  const flushMessage = () => {
    if (!currentRole || currentSegments.length === 0) return;
    messages.push({
      role: currentRole,
      content: currentSegments
        .filter((s): s is { type: 'text'; content: string } => s.type === 'text')
        .map((s) => s.content)
        .join(''),
      timestamp: currentTimestamp,
      segments: [...currentSegments],
      toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
    });
    currentSegments = [];
    currentToolCalls = [];
  };

  for (const seg of segments) {
    if (seg.segment_type === 'user') {
      if (currentRole === 'assistant') flushMessage();
      currentRole = 'user';
      currentTimestamp = seg.created_at;
      currentSegments.push({ type: 'text', content: seg.content || '' });
      flushMessage();
      currentRole = null;
    } else {
      // Assistant content (text or tool)
      if (currentRole !== 'assistant') {
        flushMessage();
        currentRole = 'assistant';
        currentTimestamp = seg.created_at;
      }
      if (seg.segment_type === 'text' && seg.content) {
        currentSegments.push({ type: 'text', content: seg.content });
      } else if (seg.segment_type === 'tool' && seg.tool_call) {
        currentSegments.push({ type: 'tool', toolCallId: seg.tool_call.id });
        currentToolCalls.push({
          toolCallId: seg.tool_call.id,
          title: seg.tool_call.title || undefined,
          kind: seg.tool_call.kind || undefined,
          status: seg.tool_call.status,
          rawInput: seg.tool_call.raw_input || undefined,
          rawOutput: seg.tool_call.raw_output || undefined,
        });
      }
    }
  }
  flushMessage(); // flush trailing assistant content

  return messages.length > 0 ? messages : undefined;
}
