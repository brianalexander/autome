import { Field } from '../ConfigPanelShared';
import type { CardRendererProps } from './types';
import { substituteTemplate } from './substitute';

/**
 * CopyUrlCard — renders a labelled URL display with a copy button.
 * Matches the webhook URL block style from the original webhook-trigger branch.
 *
 * Skips rendering when workflowId is empty (i.e. no workflow definition is available).
 */
export function CopyUrlCard({ card, stage, workflowId, apiOrigin }: CardRendererProps) {
  if (card.kind !== 'copy-url') return null;
  // Don't render if we don't have a real workflow ID (preserves original definition-gating behavior)
  if (!workflowId) return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const vars = { workflowId, stageId: stage.id, apiOrigin, config };
  const url = substituteTemplate(card.urlTemplate, vars);

  return (
    <Field label={card.title}>
      <div className="flex items-center gap-2">
        <code className="text-xs text-violet-600 dark:text-violet-300 bg-surface-secondary rounded px-2 py-1.5 flex-1 overflow-x-auto font-mono break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(url)}
          className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-1 bg-surface-tertiary rounded flex-shrink-0"
        >
          Copy
        </button>
      </div>
      {card.description && (
        <p className="text-[10px] text-text-tertiary mt-1">{card.description}</p>
      )}
    </Field>
  );
}
