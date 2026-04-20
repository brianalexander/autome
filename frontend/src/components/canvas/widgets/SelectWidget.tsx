import type { WidgetProps } from './types';

export function SelectWidget({ value, onChange, schema, disabled }: WidgetProps<string>) {
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  return (
    <select
      value={String(value ?? schema.default ?? '')}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
    >
      <option value="">— Select —</option>
      {(schema.enum ?? []).map((opt) => (
        <option key={String(opt)} value={String(opt)}>
          {String(opt)}
        </option>
      ))}
    </select>
  );
}
