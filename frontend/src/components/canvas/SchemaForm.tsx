/**
 * SchemaForm — auto-generates form fields from a JSON Schema.
 * Used by ConfigPanel for node types that don't have specialized config UIs.
 */
import { useCallback } from 'react';
import { WIDGET_REGISTRY, resolveWidget } from './widgets/index';
import type { JSONSchemaFragment } from './widgets/types';

interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  outputSchema?: Record<string, unknown>;
  nodeType?: string;
  returnSchema?: Record<string, unknown>;
  sandbox?: boolean;
  readonly?: boolean;
}

export function SchemaForm({ schema, value, onChange, readonly }: SchemaFormProps) {
  const properties = (schema.properties || {}) as Record<string, JSONSchemaFragment>;
  const required = (schema.required || []) as string[];

  const updateField = useCallback(
    (field: string, val: unknown) => {
      if (readonly) return;
      onChange({ ...value, [field]: val });
    },
    [value, onChange, readonly],
  );

  const entries = Object.entries(properties).filter(([, prop]) => {
    // Hide const fields (internal, like provider: 'manual')
    if (prop.const !== undefined) return false;

    // Conditional visibility
    const showIf = prop['x-show-if'];
    if (showIf) {
      const refProp = properties[showIf.field];
      const fieldValue = value[showIf.field] ?? refProp?.default;
      if ('equals' in showIf && fieldValue !== showIf.equals) return false;
      if ('notEquals' in showIf && fieldValue === showIf.notEquals) return false;
    }

    return true;
  });

  if (entries.length === 0) {
    return <></>;
  }

  return (
    <div className="space-y-3">
      {entries.map(([key, prop]) => (
        <SchemaField
          key={key}
          name={key}
          prop={prop}
          value={value[key]}
          required={required.includes(key)}
          onChange={(val) => updateField(key, val)}
          readonly={readonly}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  prop,
  value,
  required,
  onChange,
  readonly,
}: {
  name: string;
  prop: JSONSchemaFragment;
  value: unknown;
  required: boolean;
  onChange: (val: unknown) => void;
  readonly?: boolean;
}) {
  const label = prop.title || name;
  const widgetKey = resolveWidget(prop, name);
  const Widget = WIDGET_REGISTRY[widgetKey];

  // Field-level readOnly (JSON Schema standard) is additive with panel-level readonly.
  const isDisabled = readonly || prop.readOnly === true;

  // Guard: no-op if disabled so widgets that don't fully honour disabled prop
  // (e.g. jsdom in tests) still can't mutate state.
  const guardedOnChange = isDisabled ? () => undefined : onChange;

  // Inject SchemaForm reference into schemas that need recursive rendering,
  // avoiding a circular module import. This is the only coupling point.
  const enrichedProp: JSONSchemaFragment =
    widgetKey === 'nested' || widgetKey === 'arrayOfObjects'
      ? { ...prop, _SchemaForm: SchemaForm }
      : prop;

  // Nested object gets a fieldset wrapper
  if (widgetKey === 'nested') {
    return (
      <fieldset className="border border-border/50 rounded p-3 space-y-2">
        <legend className="text-[10px] text-text-tertiary uppercase tracking-wider px-1">{label}</legend>
        <Widget
          value={value as Record<string, unknown>}
          onChange={guardedOnChange}
          schema={enrichedProp}
          fieldName={name}
          required={required}
          disabled={isDisabled}
        />
      </fieldset>
    );
  }

  // Checkbox gets inline layout
  const isInline = widgetKey === 'checkbox';

  return (
    <Field label={label} description={prop.description} required={required} inline={isInline}>
      <Widget
        value={value}
        onChange={guardedOnChange}
        schema={enrichedProp}
        fieldName={name}
        required={required}
        disabled={isDisabled}
      />
    </Field>
  );
}

function Field({
  label,
  description,
  required,
  inline,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  inline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={inline ? 'flex items-center gap-2' : ''}>
      <label className="block text-xs text-text-secondary mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {description && <p className="text-[10px] text-text-tertiary mt-0.5">{description}</p>}
    </div>
  );
}
