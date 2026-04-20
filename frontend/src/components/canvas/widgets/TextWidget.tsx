import type { WidgetProps } from './types';

export function TextWidget({ value, onChange, schema, fieldName: _fieldName, disabled }: WidgetProps<string | undefined>) {
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  const stringValue = value == null ? (schema.default ?? '') : typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <input
      type={schema.format === 'url' ? 'url' : 'text'}
      value={String(stringValue)}
      onChange={(e) => onChange(e.target.value || undefined)}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
    />
  );
}
