// Local types — no SDK dependency

export interface ContentBlock {
  type: 'text';
  text: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}
