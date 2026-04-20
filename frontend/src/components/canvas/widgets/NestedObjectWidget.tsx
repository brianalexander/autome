import type { ComponentType } from 'react';
import type { WidgetProps, JSONSchemaFragment } from './types';

interface SchemaFormLike {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  readonly?: boolean;
}

interface NestedObjectSchema extends JSONSchemaFragment {
  /** Injected by SchemaForm so the widget can recursively render sub-forms */
  _SchemaForm?: ComponentType<SchemaFormLike>;
}

/**
 * NestedObjectWidget — renders a sub-form for an object with known properties.
 * SchemaForm injects itself as `schema._SchemaForm` to avoid a circular
 * module dependency at import time.
 */
export function NestedObjectWidget({
  value,
  onChange,
  schema,
  disabled,
}: WidgetProps<Record<string, unknown> | undefined> & { schema: NestedObjectSchema }) {
  const SubForm = schema._SchemaForm;

  if (!SubForm) {
    // Fallback: no sub-form available
    return <span className="text-xs text-text-tertiary">Object (no form available)</span>;
  }

  return (
    <SubForm
      schema={schema as Record<string, unknown>}
      value={(value as Record<string, unknown>) || {}}
      onChange={(v) => onChange(v)}
      readonly={disabled}
    />
  );
}
