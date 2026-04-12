/**
 * chatUtils — Shared types and utility functions for the ACP chat UI.
 */
import type { ToolCallRecord } from './api';
import { formatElapsed } from './format';

// --- Types ---

export type LiveSegment = { type: 'text'; content: string } | { type: 'tool'; toolCallId: string };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  segments: LiveSegment[];
  timestamp: string;
  // Optional fields populated by segmentsToMessages for persisted history restore
  content?: string;
  toolCalls?: Array<{
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: string;
    rawOutput?: string;
    parentToolUseId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

// --- Constants ---

export const THINKING_WORDS = [
  'Cogitating',
  'Pondificating',
  'Brainwaving',
  'Synaptifying',
  'Noodling',
  'Cerebrating',
  'Ruminating',
  'Thinkifying',
  'Contemplorizing',
  'Ideamotioning',
  'Meditangling',
  'Neuronifying',
  'Brainstorgling',
  'Cognitivating',
  'Deductioneering',
  'Percolathinking',
  'Mentalizering',
  'Smarticulating',
  'Logicinating',
  'Hypothesizzling',
];

// --- Formatting helpers ---

export function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function formatModelName(model: string): string {
  // Common Claude model patterns: claude-sonnet-4, claude-opus-4-5, etc.
  const claudeMatch = model.match(/^claude-(\w+)-(\d[\d.]*)/);
  if (claudeMatch) {
    const [, family, version] = claudeMatch;
    return `${family.charAt(0).toUpperCase() + family.slice(1)} ${version}`;
  }
  return model;
}

export function formatToolCallXml(tc: ToolCallRecord): string {
  const title = tc.title || tc.kind || 'tool';

  // Attributes (shared between tool_start and tool_result)
  const baseAttrs = `name="${title}"${tc.kind ? ` kind="${tc.kind}"` : ''}`;
  let startAttrs = baseAttrs + ` status="${tc.status}"`;
  const start = new Date(tc.created_at).getTime();
  const end = new Date(tc.updated_at).getTime();
  const durationSecs = Math.max(0, (end - start) / 1000);
  if (durationSecs >= 0.1) {
    startAttrs += ` duration="${durationSecs < 60 ? durationSecs.toFixed(1) + 's' : Math.floor(durationSecs / 60) + ':' + String(Math.floor(durationSecs % 60)).padStart(2, '0')}"`;
  }

  // Extract reason (intent) and input JSON, stripping internal meta-keys.
  let reason = '';
  let inputJson = '';
  if (tc.raw_input) {
    try {
      const parsed = JSON.parse(tc.raw_input);
      const { __tool_name, __mcp_server, __tool_use_purpose, ...args } = parsed;
      if (__tool_use_purpose) reason = __tool_use_purpose;
      if (Object.keys(args).length > 0) {
        inputJson = JSON.stringify(args, null, 2);
      }
    } catch {
      /* ignore */
    }
  }

  // <tool_start> — body is the raw JSON input at root indent (no `input:` label,
  // no extra nesting). Optional `reason:` line above the JSON when present.
  // No leading or trailing newlines: spacing between adjacent tool blocks is
  // controlled entirely by the caller's join separator (formatSegmentsAsTranscript
  // joins with '\n'), so consecutive tools end up flush with a single line break.
  let result = `<tool_start ${startAttrs}>`;
  if (reason) result += `\nreason: ${reason}`;
  if (inputJson) result += `\n${inputJson}`;
  result += `\n</tool_start>`;

  // <tool_result> — full output, never truncated. Copy fidelity is critical.
  if (tc.raw_output) {
    result += `\n<tool_result ${baseAttrs} status="${tc.status}">\n${tc.raw_output}\n</tool_result>`;
  }

  return result;
}

export function formatSegmentsAsTranscript(
  segments: Array<{ type: 'text'; content: string } | { type: 'tool'; toolCallId: string }>,
  toolCalls: Map<string, ToolCallRecord>,
): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === 'text' && seg.content) {
      parts.push(seg.content);
    } else if (seg.type === 'tool') {
      const tc = toolCalls.get(seg.toolCallId);
      if (tc) parts.push(formatToolCallXml(tc));
    }
  }
  return parts.join('\n');
}

// --- Segment utilities ---

export function extractTextFromSegments(segments: LiveSegment[]): string {
  return segments
    .filter((s): s is { type: 'text'; content: string } => s.type === 'text' && !!s.content)
    .map((s) => s.content)
    .join('');
}

export function computeTurnDuration(
  msg: ChatMessage,
  liveToolCalls: Map<string, ToolCallRecord>,
): string | null {
  let earliest = new Date(msg.timestamp).getTime();
  let latest = earliest;
  for (const seg of msg.segments) {
    if (seg.type === 'tool') {
      const tc = liveToolCalls.get(seg.toolCallId);
      if (tc) {
        const start = new Date(tc.created_at).getTime();
        const end = new Date(tc.updated_at).getTime();
        if (start < earliest) earliest = start;
        if (end > latest) latest = end;
      }
    }
  }
  const secs = Math.max(0, (latest - earliest) / 1000);
  return secs > 1 ? formatElapsed(secs) : null;
}

// --- Sub-agent detection ---

export function isSubAgentCall(toolCall: ToolCallRecord): boolean {
  const title = (toolCall.title || '').toLowerCase();
  if (title === 'task' || title === 'agent') return true;
  if (!toolCall.raw_input) return false;
  try {
    const input = JSON.parse(toolCall.raw_input);
    // Only subagent_type is unique to Agent/Task tools.
    // Do NOT check for `prompt` alone — WebFetch also has a `prompt` field.
    if (input.subagent_type) return true;
  } catch {}
  return false;
}

export function extractSubAgentInfo(rawInput: string | null): { type?: string; description?: string; prompt?: string } | null {
  if (!rawInput) return null;
  try {
    const input = JSON.parse(rawInput);
    const { __tool_name, __mcp_server, __tool_use_purpose, ...rest } = input;
    if (rest.subagent_type || rest.description || rest.prompt) {
      return {
        type: rest.subagent_type,
        description: rest.description,
        prompt: rest.prompt,
      };
    }
  } catch {}
  return null;
}
