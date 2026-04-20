import type { WidgetProps } from './types';

export function SelectWidget({ value, onChange, schema, disabled }: WidgetProps<string>) {
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  const enumValues = (schema.enum ?? []) as unknown[];
  const enumLabels = schema['x-enum-labels'];

  return (
    <select
      value={String(value ?? schema.default ?? '')}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
    >
      <option value="">— Select —</option>
      {enumValues.map((opt, i) => (
        <option key={String(opt)} value={String(opt)}>
          {enumLabels?.[i] ?? String(opt)}
        </option>
      ))}
    </select>
  );
}
