import type { WidgetProps } from './types';

export function DatetimeWidget({ value, onChange, disabled }: WidgetProps<string | undefined>) {
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  return (
    <input
      type="datetime-local"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
    />
  );
}
