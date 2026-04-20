import type { CardRendererProps } from './types';

/**
 * PreviewTemplateCard — renders a nunjucks template preview against a mock event context.
 * The `field` property names which config field contains the template to preview.
 *
 * TODO (Phase 4): Wire up real nunjucks rendering with a mock workflow context.
 * For now, renders the raw template value as read-only text.
 */
export function PreviewTemplateCard({ card, stage }: CardRendererProps) {
  if (card.kind !== 'preview-template') return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const templateValue = config[card.field];

  if (!templateValue) return null;

  return (
    <div className="bg-surface-secondary rounded-lg p-3">
      {card.title && (
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">
          {card.title}
        </div>
      )}
      {card.description && (
        <p className="text-[10px] text-text-tertiary mb-2">{card.description}</p>
      )}
      <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap">
        {typeof templateValue === 'string' ? templateValue : JSON.stringify(templateValue, null, 2)}
      </pre>
    </div>
  );
}
