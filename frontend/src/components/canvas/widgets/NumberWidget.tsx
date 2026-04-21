import type { WidgetProps } from './types';

export function NumberWidget({ value, onChange, schema, disabled }: WidgetProps<number | undefined>) {
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  return (
    <input
      type="number"
      value={value != null ? String(value) : ''}
      placeholder={schema['x-placeholder'] ?? (schema.default != null ? String(schema.default) : undefined)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono${disabledCls}`}
    />
  );
}
