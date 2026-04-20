import type { WidgetProps } from './types';

/** Array of enum values — rendered as a scrollable checkbox list. */
export function MultiSelectWidget({ value, onChange, schema, disabled }: WidgetProps<string[] | undefined>) {
  const selected = Array.isArray(value) ? value : [];
  const options = (schema.items?.enum ?? []) as string[];

  const toggle = (opt: string) => {
    if (disabled) return;
    if (selected.includes(opt)) {
      onChange(selected.filter((v) => v !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  return (
    <div className={`space-y-1 ${options.length > 10 ? 'max-h-48 overflow-y-auto' : ''} border border-border rounded px-2 py-1.5 bg-surface-secondary`}>
      {options.length === 0 && (
        <span className="text-xs text-text-tertiary">No options defined</span>
      )}
      {options.map((opt) => (
        <label key={opt} className={`flex items-center gap-2 text-sm text-text-primary cursor-pointer${disabled ? ' opacity-60 cursor-default' : ''}`}>
          <input
            type="checkbox"
            checked={selected.includes(opt)}
            onChange={() => toggle(opt)}
            disabled={disabled}
            className="rounded border-border"
          />
          {opt}
        </label>
      ))}
    </div>
  );
}
