import type { CardRendererProps } from './types';

/**
 * ActivationStatusCard — renders an Active/Inactive badge based on workflow.active.
 *
 * TODO (Phase 4): Populate with real activation status and controls.
 * For now, reads workflow.active from the definition prop if available.
 */
export function ActivationStatusCard({ card, definition }: CardRendererProps) {
  if (card.kind !== 'activation-status') return null;

  const isActive = (definition as { active?: boolean } | undefined)?.active ?? false;

  return (
    <div className="bg-surface-secondary rounded-lg p-3">
      {card.title && (
        <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">
          {card.title}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
            isActive
              ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
              : 'bg-surface-tertiary text-text-tertiary'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-text-tertiary'}`}
          />
          {isActive ? 'Active' : 'Inactive'}
        </span>
      </div>
    </div>
  );
}
