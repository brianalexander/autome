/**
 * SchemaForm — auto-generates form fields from a JSON Schema.
 * Used by ConfigPanel for node types that don't have specialized config UIs.
 */
import { useCallback, useState, useEffect } from 'react';
import { CodeEditor } from './CodeEditor';

interface JSONSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  const?: unknown;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  'x-show-if'?: {
    field: string;
    equals?: unknown;
    notEquals?: unknown;
  };
}

interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  outputSchema?: Record<string, unknown>;
  nodeType?: string;
  returnSchema?: Record<string, unknown>;
}

export function SchemaForm({ schema, value, onChange, outputSchema, nodeType, returnSchema }: SchemaFormProps) {
  const properties = (schema.properties || {}) as Record<string, JSONSchemaProperty>;
  const required = (schema.required || []) as string[];

  const updateField = useCallback(
    (field: string, val: unknown) => {
      onChange({ ...value, [field]: val });
    },
    [value, onChange],
  );

  const entries = Object.entries(properties).filter(([, prop]) => {
    // Hide const fields (internal, like provider: 'manual')
    if (prop.const !== undefined) return false;

    // Conditional visibility
    const showIf = prop['x-show-if'];
    if (showIf) {
      // Use the current value, falling back to the referenced field's default
      const refProp = properties[showIf.field];
      const fieldValue = value[showIf.field] ?? refProp?.default;
      if ('equals' in showIf && fieldValue !== showIf.equals) return false;
      if ('notEquals' in showIf && fieldValue === showIf.notEquals) return false;
    }

    return true;
  });

  if (entries.length === 0) {
    return <div className="text-xs text-text-tertiary py-2">No configuration needed.</div>;
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
          outputSchema={outputSchema}
          nodeType={nodeType}
          returnSchema={returnSchema}
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
  outputSchema,
  nodeType,
  returnSchema,
}: {
  name: string;
  prop: JSONSchemaProperty;
  value: unknown;
  required: boolean;
  onChange: (val: unknown) => void;
  outputSchema?: Record<string, unknown>;
  nodeType?: string;
  returnSchema?: Record<string, unknown>;
}) {
  const label = prop.title || name;

  // Nested object
  if (prop.type === 'object' && prop.properties) {
    return (
      <fieldset className="border border-border/50 rounded p-3 space-y-2">
        <legend className="text-[10px] text-text-tertiary uppercase tracking-wider px-1">{label}</legend>
        <SchemaForm
          schema={prop as Record<string, unknown>}
          value={(value as Record<string, unknown>) || {}}
          onChange={(v) => onChange(v)}
          outputSchema={outputSchema}
          nodeType={nodeType}
          returnSchema={returnSchema}
        />
      </fieldset>
    );
  }

  // Enum → select dropdown
  if (prop.enum) {
    return (
      <Field label={label} description={prop.description} required={required}>
        <select
          value={String(value ?? prop.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary"
        >
          <option value="">— Select —</option>
          {prop.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  // Boolean → checkbox
  if (prop.type === 'boolean') {
    return (
      <Field label={label} description={prop.description} required={required} inline>
        <input
          type="checkbox"
          checked={Boolean(value ?? prop.default ?? false)}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-border"
        />
      </Field>
    );
  }

  // Number
  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <Field label={label} description={prop.description} required={required}>
        <input
          type="number"
          value={value != null ? String(value) : ''}
          placeholder={prop.default != null ? String(prop.default) : undefined}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          className="w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono"
        />
      </Field>
    );
  }

  // Multiline textarea for templates, prompts, and other non-code text
  if (prop.format === 'textarea') {
    const displayValue = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return (
      <Field label={label} description={prop.description} required={required}>
        <textarea
          value={String(displayValue)}
          onChange={(e) => onChange(e.target.value || undefined)}
          rows={4}
          className="w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y"
          spellCheck={false}
        />
      </Field>
    );
  }

  // Dependencies editor — key-value pairs for npm packages
  if (prop.format === 'dependencies' || name === 'dependencies') {
    return (
      <DependencyEditor
        label={label}
        description={prop.description}
        required={required}
        value={value}
        onChange={onChange}
      />
    );
  }

  // String with format: 'code' or 'json' → CodeMirror editor with syntax highlighting
  if (prop.format === 'code' || prop.format === 'json') {
    const displayValue =
      value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const editorContext = prop.format === 'json'
      ? 'json'
      : (name === 'condition' || name === 'expression')
        ? 'condition'
        : 'code';
    return (
      <Field label={label} description={prop.description} required={required}>
        <CodeEditor
          value={String(displayValue)}
          editorMode={editorContext}
          outputSchema={outputSchema}
          nodeType={nodeType}
          returnSchema={returnSchema}
          onChange={(raw) => {
            // Try to parse as JSON if it looks like an array/object
            if (raw.startsWith('[') || raw.startsWith('{')) {
              try {
                onChange(JSON.parse(raw));
                return;
              } catch {}
            }
            onChange(raw || undefined);
          }}
          minHeight={name === 'code' ? '160px' : '80px'}
        />
        {prop.format === 'json' && typeof value === 'string' && value.trim() && (() => {
          try { JSON.parse(value); return null; } catch (e) {
            return <p className="text-[10px] text-red-500 mt-1">Invalid JSON: {(e as Error).message}</p>;
          }
        })()}
      </Field>
    );
  }

  // Default: string input
  const stringValue = value == null ? (prop.default ?? '') : typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <Field label={label} description={prop.description} required={required}>
      <input
        type={prop.format === 'url' ? 'url' : 'text'}
        value={String(stringValue)}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary"
      />
    </Field>
  );
}

function DependencyEditor({
  label,
  description,
  required,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  required: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const deps = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string>;
  const serialized = Object.entries(deps)
    .map(([pkg, ver]) => (ver && ver !== 'latest' ? `${pkg}@${ver}` : pkg))
    .join('\n');

  const [text, setText] = useState(serialized);
  const [focused, setFocused] = useState(false);

  // Sync from parent when not focused (external changes)
  useEffect(() => {
    if (!focused) setText(serialized);
  }, [serialized, focused]);

  const commitValue = (raw: string) => {
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Support "lodash@^4.17.21" or "lodash@latest" or just "lodash"
      const atIdx = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
      if (atIdx > 0) {
        parsed[trimmed.slice(0, atIdx)] = trimmed.slice(atIdx + 1);
      } else {
        parsed[trimmed] = 'latest';
      }
    }
    onChange(Object.keys(parsed).length > 0 ? parsed : undefined);
  };

  return (
    <Field label={label} description={description} required={required}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          commitValue(e.target.value);
        }}
        rows={2}
        className="w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y"
        spellCheck={false}
        placeholder={"lodash@^4.17.21\naxios@^1.7.0"}
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
