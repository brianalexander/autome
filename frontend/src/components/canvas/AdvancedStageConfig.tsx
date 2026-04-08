import {
  type StageDefinition,
  type WorkflowDefinition,
} from '../../lib/api';
import { Field } from './ConfigPanelShared';

/** Advanced config section: fan-in trigger rule, retry, dynamic map. Shown for all step node types. */
export function AdvancedStageConfig({
  editState,
  definition,
  onUpdate,
}: {
  editState: StageDefinition;
  definition: WorkflowDefinition;
  onUpdate: (path: string, value: unknown) => void;
}) {
  // Only show fan-in trigger rule if the stage has multiple incoming edges
  const incomingEdgeCount = definition.edges.filter((e) => e.target === editState.id).length;

  return (
    <div className="space-y-3 pt-3 border-t border-border/50">
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Advanced</div>

      {/* Input mode — only show when multiple incoming edges */}
      {incomingEdgeCount > 1 && (
        <Field label="Input Mode">
          <select
            value={editState.input_mode || 'queue'}
            onChange={(e) => onUpdate('input_mode', e.target.value === 'queue' ? undefined : e.target.value)}
            className="input-field text-xs"
          >
            <option value="queue">Queue (process each input independently)</option>
            <option value="fan_in">Join (wait for multiple inputs)</option>
          </select>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {(editState.input_mode || 'queue') === 'fan_in'
              ? 'Waits for upstream stages to complete before executing. Use the Join Rule below to control when.'
              : 'Each incoming edge triggers an independent execution, processed one at a time in FIFO order.'}
          </div>
        </Field>
      )}

      {/* Fan-in trigger rule — only show when input_mode is fan_in */}
      {incomingEdgeCount > 1 && (editState.input_mode || 'queue') === 'fan_in' && (
        <Field label="Join Rule">
          <select
            value={editState.trigger_rule || 'all_success'}
            onChange={(e) => onUpdate('trigger_rule', e.target.value === 'all_success' ? undefined : e.target.value)}
            className="input-field text-xs"
          >
            <option value="all_success">Wait for all (all must succeed)</option>
            <option value="any_success">Any (fire on first success)</option>
            <option value="none_failed_min_one_success">Flexible (at least one success, none failed)</option>
          </select>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {editState.trigger_rule === 'any_success'
              ? 'Fires as soon as any upstream stage completes successfully.'
              : editState.trigger_rule === 'none_failed_min_one_success'
                ? 'Fires when all upstreams finish, if at least one succeeded and none failed. Skipped branches are OK.'
                : 'Waits for every upstream stage to succeed before firing.'}
          </div>
        </Field>
      )}

      {/* Retry */}
      <Field label="Retry on Failure">
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={editState.retry?.max_attempts ?? ''}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (isNaN(val) || val <= 1) {
                onUpdate('retry', undefined);
              } else {
                onUpdate('retry', { ...editState.retry, max_attempts: val });
              }
            }}
            className="input-field w-16"
            min={1}
            max={10}
            placeholder="1"
          />
          <span className="text-xs text-text-secondary">attempts</span>
        </div>
        {editState.retry && editState.retry.max_attempts > 1 && (
          <div className="flex gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-text-secondary">Delay</label>
              <input
                type="number"
                value={editState.retry.delay_ms ?? 1000}
                onChange={(e) => onUpdate('retry', { ...editState.retry, delay_ms: parseInt(e.target.value) || 1000 })}
                className="input-field w-20"
                min={0}
                step={500}
              />
              <span className="text-[10px] text-text-tertiary">ms</span>
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-text-secondary">Backoff</label>
              <input
                type="number"
                value={editState.retry.backoff_multiplier ?? 2}
                onChange={(e) =>
                  onUpdate('retry', { ...editState.retry, backoff_multiplier: parseFloat(e.target.value) || 2 })
                }
                className="input-field w-14"
                min={1}
                step={0.5}
              />
              <span className="text-[10px] text-text-tertiary">x</span>
            </div>
          </div>
        )}
      </Field>

      {/* Dynamic Map */}
      <Field label="Map Over (Fan-out)">
        <input
          type="text"
          value={editState.map_over ?? ''}
          onChange={(e) => onUpdate('map_over', e.target.value || undefined)}
          className="input-field text-xs font-mono"
          placeholder="{{ stages.splitter.output.items }}"
        />
        <div className="text-[10px] text-text-tertiary mt-0.5">
          Template expression resolving to an array. Stage runs once per element.
        </div>
      </Field>

      {editState.map_over && (
        <>
          <Field label="Concurrency Limit">
            <input
              type="number"
              value={editState.concurrency ?? ''}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onUpdate('concurrency', isNaN(val) ? undefined : val);
              }}
              className="input-field w-20"
              min={1}
              placeholder="∞"
            />
          </Field>
          <Field label="Failure Tolerance">
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={editState.failure_tolerance ?? 0}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  onUpdate('failure_tolerance', isNaN(val) ? 0 : val);
                }}
                className="input-field w-16"
                min={0}
              />
              <span className="text-xs text-text-secondary">allowed failures</span>
            </div>
          </Field>
        </>
      )}
    </div>
  );
}
