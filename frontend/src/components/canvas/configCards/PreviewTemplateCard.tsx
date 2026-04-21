import { useMemo } from 'react';
import nunjucks from 'nunjucks';
import type { CardRendererProps } from './types';
import { buildMockContext } from '../../../lib/mockContext';

// Configure a nunjucks environment: no filesystem, autoescape off (building prompts not HTML)
const nunjucksEnv = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

/**
 * PreviewTemplateCard — renders a live Nunjucks preview of a template config field.
 *
 * Synthesizes a mock workflow context by walking the graph upstream of the current stage
 * and sampling each upstream node's output_schema. Renders the template against that
 * mock context so users can eyeball expected output while they edit.
 *
 * The `field` property names which config field contains the template to preview.
 */
export function PreviewTemplateCard({ card, stage, definition }: CardRendererProps) {
  if (card.kind !== 'preview-template') return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const templateValue = config[card.field];

  if (!templateValue || typeof templateValue !== 'string' || templateValue.trim() === '') return null;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const result = useMemo(() => {
    // Build mock context from the workflow graph (if definition is available)
    const mockCtx = definition
      ? buildMockContext(stage.id, definition)
      : { trigger: { prompt: 'Sample prompt' }, stages: {} };

    try {
      const rendered = nunjucksEnv.renderString(templateValue, mockCtx);
      return { kind: 'ok' as const, rendered };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'error' as const, message };
    }
  }, [templateValue, stage.id, definition]);

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
      {result.kind === 'error' ? (
        <div className="rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 p-2">
          <p className="text-[11px] text-red-700 dark:text-red-400 font-mono whitespace-pre-wrap">
            {result.message}
          </p>
        </div>
      ) : (
        <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap">
          {result.rendered}
        </pre>
      )}
    </div>
  );
}
