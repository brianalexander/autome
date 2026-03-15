/**
 * ReadOnlySchemaView — displays config values using a JSON Schema for structure.
 * Used in the instance viewer to show stage configurations as structured,
 * read-only fields instead of raw JSON dumps.
 */

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

interface ReadOnlySchemaViewProps {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
}

export function ReadOnlySchemaView({ schema, values }: ReadOnlySchemaViewProps) {
  const properties = (schema.properties || {}) as Record<string, JSONSchemaProperty>;

  const entries = Object.entries(properties).filter(([, prop]) => {
    // Hide const fields (internal, like provider: 'manual')
    if (prop.const !== undefined) return false;

    // Conditional visibility — same logic as SchemaForm
    const showIf = prop['x-show-if'];
    if (showIf) {
      const refProp = properties[showIf.field];
      const fieldValue = values[showIf.field] ?? refProp?.default;
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
        <ReadOnlyField key={key} name={key} prop={prop} value={values[key]} values={values} />
      ))}
    </div>
  );
}

function ReadOnlyField({
  name,
  prop,
  value,
  values,
}: {
  name: string;
  prop: JSONSchemaProperty;
  value: unknown;
  values: Record<string, unknown>;
}) {
  const label = prop.title || name;
  const displayValue = value ?? prop.default;

  // Nested object with sub-schema
  if (prop.type === 'object' && prop.properties) {
    return (
      <fieldset className="border border-border/50 rounded p-3 space-y-2">
        <legend className="text-[10px] text-text-tertiary uppercase tracking-wider px-1">{label}</legend>
        <ReadOnlySchemaView
          schema={prop as Record<string, unknown>}
          values={(displayValue as Record<string, unknown>) || {}}
        />
      </fieldset>
    );
  }

  // Dependencies format (key-value pairs)
  if (prop.format === 'dependencies' || name === 'dependencies') {
    const deps =
      displayValue && typeof displayValue === 'object' && !Array.isArray(displayValue)
        ? (displayValue as Record<string, string>)
        : {};
    const depLines = Object.entries(deps)
      .map(([pkg, ver]) => (ver && ver !== 'latest' ? `${pkg}@${ver}` : pkg))
      .join('\n');
    return (
      <FieldWrapper label={label} description={prop.description}>
        {depLines ? (
          <pre className="text-xs text-text-secondary bg-surface-secondary rounded px-2 py-1.5 overflow-x-auto font-mono whitespace-pre-wrap">
            {depLines}
          </pre>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        )}
      </FieldWrapper>
    );
  }

  // Code/JSON format or code-like fields
  if (
    prop.format === 'code' ||
    prop.format === 'json' ||
    prop.format === 'textarea' ||
    name === 'code' ||
    name === 'expression' ||
    name === 'condition'
  ) {
    const text =
      displayValue == null
        ? null
        : typeof displayValue === 'string'
          ? displayValue
          : JSON.stringify(displayValue, null, 2);
    return (
      <FieldWrapper label={label} description={prop.description}>
        {text ? (
          <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words font-mono">
            {text}
          </pre>
        ) : (
          <span className="text-sm text-text-muted">—</span>
        )}
      </FieldWrapper>
    );
  }

  // Arrays and plain objects without sub-schema
  if (
    displayValue !== null &&
    displayValue !== undefined &&
    typeof displayValue === 'object'
  ) {
    return (
      <FieldWrapper label={label} description={prop.description}>
        <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-words font-mono">
          {JSON.stringify(displayValue, null, 2)}
        </pre>
      </FieldWrapper>
    );
  }

  // Boolean
  if (prop.type === 'boolean') {
    return (
      <FieldWrapper label={label} description={prop.description}>
        <span className="text-sm text-text-primary">
          {displayValue === true ? 'Yes' : displayValue === false ? 'No' : <span className="text-text-muted">—</span>}
        </span>
      </FieldWrapper>
    );
  }

  // Scalars (string, number, enum)
  const text =
    displayValue == null || displayValue === ''
      ? null
      : String(displayValue);

  return (
    <FieldWrapper label={label} description={prop.description}>
      {text ? (
        <span className="text-sm text-text-primary break-words">{text}</span>
      ) : (
        <span className="text-sm text-text-muted">—</span>
      )}
    </FieldWrapper>
  );
}

function FieldWrapper({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">{label}</div>
      <div>{children}</div>
      {description && <p className="text-[10px] text-text-tertiary mt-0.5">{description}</p>}
    </div>
  );
}
