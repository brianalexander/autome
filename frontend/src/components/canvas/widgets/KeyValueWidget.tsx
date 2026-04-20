import { Plus, X } from 'lucide-react';
import type { WidgetProps } from './types';

/** Dict editor with "+ Add" button and rows of [key] [value] [x]. Stores as Record<string, string>. */
export function KeyValueWidget({ value, onChange, disabled }: WidgetProps<Record<string, string> | undefined>) {
  const dict = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string>;
  const entries = Object.entries(dict);

  const update = (index: number, key: string, val: string) => {
    if (disabled) return;
    const newEntries = [...entries];
    newEntries[index] = [key, val];
    onChange(Object.fromEntries(newEntries));
  };

  const remove = (index: number) => {
    if (disabled) return;
    const newEntries = entries.filter((_, i) => i !== index);
    onChange(newEntries.length > 0 ? Object.fromEntries(newEntries) : undefined);
  };

  const add = () => {
    if (disabled) return;
    const newDict = { ...dict, '': '' };
    onChange(newDict);
  };

  const inputCls = `bg-surface-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono${disabled ? ' opacity-60 cursor-default' : ''}`;

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={k}
            onChange={(e) => update(i, e.target.value, v)}
            disabled={disabled}
            placeholder="key"
            className={`flex-1 ${inputCls}`}
          />
          <input
            type="text"
            value={v}
            onChange={(e) => update(i, k, e.target.value)}
            disabled={disabled}
            placeholder="value"
            className={`flex-1 ${inputCls}`}
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-text-tertiary hover:text-text-primary flex-shrink-0"
              aria-label="Remove row"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      )}
    </div>
  );
}
