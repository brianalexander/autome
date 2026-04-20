import type { CardRendererProps } from './types';
import { substituteTemplate } from './substitute';

/**
 * CurlSnippetCard — renders a styled info panel with prose and fenced code blocks.
 * Matches the `bg-surface-secondary rounded-lg p-3 space-y-3` style from
 * the original manual-trigger and webhook-trigger branches.
 *
 * Template syntax: prose lines are rendered as text; ``` fenced blocks are rendered
 * as <pre> elements.
 *
 * Skips rendering when workflowId is empty (preserves original definition-gating behavior).
 */
export function CurlSnippetCard({ card, stage, workflowId, apiOrigin }: CardRendererProps) {
  if (card.kind !== 'curl-snippet') return null;
  // Don't render when no workflow definition is available (original JSX gated on `definition &&`)
  if (!workflowId) return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const vars = { workflowId, stageId: stage.id, apiOrigin, config };
  const content = substituteTemplate(card.template, vars);

  const segments = parseTemplate(content);

  return (
    <div className="bg-surface-secondary rounded-lg p-3 space-y-3">
      {card.title && (
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">
          {card.title}
        </div>
      )}
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <pre key={i} className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap">
            {seg.text}
          </pre>
        ) : (
          <p key={i} className="text-xs text-text-secondary">
            <InlineCode text={seg.text} />
          </p>
        ),
      )}
      {card.description && (
        <p className="text-[10px] text-text-tertiary">{card.description}</p>
      )}
    </div>
  );
}

type Segment = { kind: 'prose' | 'code'; text: string };

/** Split a template string into prose and fenced code block segments. */
function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  const lines = template.split('\n');
  let inCode = false;
  let buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        // End of code block
        segments.push({ kind: 'code', text: buffer.join('\n') });
        buffer = [];
        inCode = false;
      } else {
        // Start of code block — flush prose buffer first
        if (buffer.length > 0) {
          const prose = buffer.join('\n').trim();
          if (prose) segments.push({ kind: 'prose', text: prose });
          buffer = [];
        }
        inCode = true;
      }
    } else {
      buffer.push(line);
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    const text = buffer.join('\n').trim();
    if (text) {
      segments.push({ kind: inCode ? 'code' : 'prose', text });
    }
  }

  return segments;
}

/**
 * Render a line of text, converting backtick-wrapped segments to inline code.
 */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          const code = part.slice(1, -1);
          return (
            <code key={i} className="text-violet-600 dark:text-violet-300 bg-surface-tertiary px-1 rounded">
              {code}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
