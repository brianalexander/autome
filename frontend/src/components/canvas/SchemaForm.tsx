/**
 * SchemaForm — auto-generates form fields from a JSON Schema.
 * Used by ConfigPanel for node types that don't have specialized config UIs.
 */
import { useCallback, useState, useEffect } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
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
  sandbox?: boolean;
  readonly?: boolean;
}

export function SchemaForm({ schema, value, onChange, outputSchema, nodeType, returnSchema, sandbox, readonly }: SchemaFormProps) {
  const properties = (schema.properties || {}) as Record<string, JSONSchemaProperty>;
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
          sandbox={sandbox}
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
  outputSchema,
  nodeType,
  returnSchema,
  sandbox,
  readonly,
}: {
  name: string;
  prop: JSONSchemaProperty;
  value: unknown;
  required: boolean;
  onChange: (val: unknown) => void;
  outputSchema?: Record<string, unknown>;
  nodeType?: string;
  returnSchema?: Record<string, unknown>;
  sandbox?: boolean;
  readonly?: boolean;
}) {
  const label = prop.title || name;

  const disabledCls = readonly ? ' opacity-60 cursor-default' : '';

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
          readonly={readonly}
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
          disabled={readonly}
          className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
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
          disabled={readonly}
          className={`rounded border-border${disabledCls}`}
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
          disabled={readonly}
          className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono${disabledCls}`}
        />
      </Field>
    );
  }

  // Multiline textarea for templates, prompts, and other non-code text
  if (prop.format === 'textarea') {
    return <ExpandableTextarea label={label} description={prop.description} required={required} value={value} onChange={onChange} readonly={readonly} />;
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
        readonly={readonly}
      />
    );
  }

  // String with format: 'code', 'json', or 'template' → CodeMirror editor
  if (prop.format === 'code' || prop.format === 'json' || prop.format === 'template') {
    const displayValue =
      value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const editorContext = prop.format === 'json'
      ? 'json'
      : prop.format === 'template'
        ? 'template'
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
          sandbox={sandbox}
          readOnly={readonly}
          onChange={(raw) => {
            if (readonly) return;
            // Try to parse as JSON if it looks like an array/object
            if (raw.startsWith('[') || raw.startsWith('{')) {
              try {
                onChange(JSON.parse(raw));
                return;
              } catch {}
            }
            onChange(raw || undefined);
          }}
          minHeight={name === 'code' ? '160px' : prop.format === 'template' ? '120px' : '80px'}
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
        disabled={readonly}
        className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
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
  readonly,
}: {
  label: string;
  description?: string;
  required: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
  readonly?: boolean;
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
          if (!readonly) commitValue(e.target.value);
        }}
        rows={2}
        disabled={readonly}
        className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y${readonly ? ' opacity-60 cursor-default' : ''}`}
        spellCheck={false}
        placeholder={"lodash@^4.17.21\naxios@^1.7.0"}
      />
    </Field>
  );
}

/** Textarea with expand-to-modal for prompt templates and other long-form text. */
function ExpandableTextarea({
  label,
  description,
  required,
  value,
  onChange,
  readonly,
}: {
  label: string;
  description?: string;
  required?: boolean;
  value: unknown;
  onChange: (val: unknown) => void;
  readonly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node && expanded) node.focus();
  }, [expanded]);
  const displayValue = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  // Close on Escape, stop propagation so ConfigPanel doesn't also close
  useEffect(() => {
    if (!expanded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [expanded]);

  return (
    <Field label={label} description={description} required={required}>
      {/* Backdrop */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setExpanded(false)} />
      )}

      <div className={expanded
        ? 'fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none'
        : 'relative group'
      }>
        <div className={expanded
          ? 'bg-surface border border-border rounded-xl w-[90vw] max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl pointer-events-auto'
          : ''
        }>
          {expanded && (
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
              <span className="text-xs font-medium text-text-secondary">{label}</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-tertiary">Esc to close</span>
                <button
                  onClick={() => setExpanded(false)}
                  className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-surface-secondary"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  Collapse
                </button>
              </div>
            </div>
          )}
          <div className={expanded ? 'flex-1 overflow-auto p-3' : ''}>
            <textarea
              ref={textareaRef}
              value={String(displayValue)}
              onChange={(e) => { if (!readonly) onChange(e.target.value || undefined); }}
              rows={expanded ? 20 : 4}
              disabled={readonly}
              className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y${readonly ? ' opacity-60 cursor-default' : ''}`}
              spellCheck={false}
              placeholder="Enter prompt template... Use {{ output.field }} for interpolation"
            />
          </div>
        </div>

        {/* Expand button — inline mode only */}
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-surface-secondary/90 border border-border rounded p-1 text-text-tertiary hover:text-text-primary"
            title="Expand editor"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
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
