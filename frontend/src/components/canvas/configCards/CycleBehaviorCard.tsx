import type { CardRendererProps } from './types';
import type { WorkflowDefinition } from '../../../lib/api';
import { Field } from '../ConfigPanelShared';

/**
 * CycleBehaviorCard — renders the ↻ Cycle Behavior section (header + select) only
 * when this stage participates in a cycle edge (reachable from itself).
 *
 * This mirrors the `canStageCycle` + Cycle Behavior section from the original AgentConfigSection.
 * The `cycle_behavior` field is NOT in AgentNodeSpec.configSchema so SchemaForm won't duplicate it.
 */
export function CycleBehaviorCard({ card, stage, definition, onConfigChange, readonly }: CardRendererProps) {
  if (card.kind !== 'cycle-behavior') return null;
  if (!definition || !canStageCycle(stage.id, definition)) return null;

  const config = (stage.config || {}) as Record<string, unknown>;
  const value = (config.cycle_behavior as string) || 'fresh';

  return (
    <div className="border-t border-border pt-4">
      <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3 flex items-center gap-1.5">
        <span className="text-rose-400">↻</span>{' '}
        {card.title ?? 'Cycle Behavior'}
      </div>
      <Field
        label="Session Mode"
        description="How this agent's session is handled when re-entered via a cycle edge"
      >
        <select
          value={value}
          onChange={(e) => onConfigChange?.('config.cycle_behavior', e.target.value)}
          disabled={readonly || !onConfigChange}
          className={`input-field${readonly || !onConfigChange ? ' opacity-60 cursor-default' : ''}`}
        >
          <option value="fresh">Fresh — new session each cycle</option>
          <option value="continue">Continue — resume prior session</option>
        </select>
      </Field>
    </div>
  );
}

function canStageCycle(stageId: string, definition: WorkflowDefinition): boolean {
  const reachable = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of definition.edges) {
      if (edge.source === current && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return definition.edges.some((e) => e.target === stageId && reachable.has(e.source));
}
