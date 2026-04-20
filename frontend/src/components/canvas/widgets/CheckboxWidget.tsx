import type { WidgetProps } from './types';

export function CheckboxWidget({ value, onChange, schema, disabled }: WidgetProps<boolean>) {
  return (
    <input
      type="checkbox"
      checked={Boolean(value ?? schema.default ?? false)}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className={`rounded border-border${disabled ? ' opacity-60 cursor-default' : ''}`}
    />
  );
}
