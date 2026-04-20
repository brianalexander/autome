import type { CardRendererProps } from './types';
import { substituteTemplate } from './substitute';

/**
 * HelpTextCard — renders a styled info panel with a title and markdown-like text.
 * Matches the `bg-surface-secondary rounded-lg p-3` panel style from the original cron-trigger branch.
 */
export function HelpTextCard({ card, stage, workflowId, apiOrigin }: CardRendererProps) {
  if (card.kind !== 'help-text') return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const vars = { workflowId, stageId: stage.id, apiOrigin, config };
  const content = substituteTemplate(card.markdown, vars);

  // Split content into paragraphs — lines starting with a backtick-wrapped value get inline code treatment
  const lines = content.split('\n');

  return (
    <div className="bg-surface-secondary rounded-lg p-3">
      {card.title && (
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">
          {card.title}
        </div>
      )}
      <div className="space-y-1.5">
        {lines.map((line, i) => {
          if (!line.trim()) return null;
          return (
            <p key={i} className="text-xs text-text-secondary">
              <InlineCode text={line} />
            </p>
          );
        })}
      </div>
    </div>
  );
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
            <code key={i} className="text-blue-600 dark:text-blue-300 bg-surface-tertiary px-1 rounded">
              {code}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
