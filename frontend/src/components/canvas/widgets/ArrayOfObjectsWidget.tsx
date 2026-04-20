import type { ComponentType } from 'react';
import { Plus, X } from 'lucide-react';
import type { WidgetProps, JSONSchemaFragment } from './types';

interface SchemaFormLike {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  readonly?: boolean;
}

interface ArrayOfObjectsSchema extends JSONSchemaFragment {
  /** Injected by SchemaForm so the widget can recursively render sub-forms */
  _SchemaForm?: ComponentType<SchemaFormLike>;
}

/**
 * ArrayOfObjectsWidget — repeating record editor. Each item is a sub-card
 * rendered via SchemaForm to get recursive widget dispatch.
 *
 * SchemaForm injects itself as `schema._SchemaForm` to avoid a circular
 * module dependency at import time.
 */
export function ArrayOfObjectsWidget({ value, onChange, schema, disabled }: WidgetProps<Record<string, unknown>[] | undefined> & { schema: ArrayOfObjectsSchema }) {
  const items: Record<string, unknown>[] = Array.isArray(value) ? value : [];
  const itemSchema = (schema.items as JSONSchemaFragment | undefined) ?? {};
  const SubForm = schema._SchemaForm;

  const add = () => {
    if (disabled) return;
    onChange([...items, {}]);
  };

  const remove = (index: number) => {
    if (disabled) return;
    onChange(items.filter((_, i) => i !== index));
  };

  const update = (index: number, val: Record<string, unknown>) => {
    if (disabled) return;
    const next = [...items];
    next[index] = val;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="border border-border/50 rounded p-2 space-y-1.5 relative">
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute top-1.5 right-1.5 text-text-tertiary hover:text-text-primary"
              aria-label={`Remove item ${i + 1}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {SubForm ? (
            <SubForm
              schema={itemSchema as Record<string, unknown>}
              value={item}
              onChange={(v) => update(i, v)}
              readonly={disabled}
            />
          ) : (
            <span className="text-xs text-text-tertiary">Item {i + 1}</span>
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
          Add item
        </button>
      )}
    </div>
  );
}
