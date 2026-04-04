import { useState, useRef, useEffect, useMemo } from 'react';

interface SchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
}

interface TriggerDialogProps {
  workflowName: string;
  isOpen: boolean;
  onClose: () => void;
  onTrigger: (payload: Record<string, unknown>) => void;
  isPending?: boolean;
  outputSchema?: Record<string, unknown>;
  validation?: {
    valid: boolean;
    summary: string;
    errors: string[];
    warnings: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// Schema-driven form
// ---------------------------------------------------------------------------

interface SchemaFormProps {
  properties: Record<string, SchemaProperty>;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}

function SchemaForm({ properties, values, onChange, disabled }: SchemaFormProps) {
  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, prop]) => {
        const type = prop.type ?? 'string';
        const value = values[key] ?? '';

        if (type === 'boolean') {
          return (
            <div key={key} className="flex items-start gap-3">
              <input
                id={`schema-field-${key}`}
                type="checkbox"
                checked={value === 'true'}
                onChange={(e) => onChange(key, e.target.checked ? 'true' : 'false')}
                disabled={disabled}
                className="mt-0.5 h-4 w-4 rounded border-border-subtle text-blue-600 focus:ring-blue-500"
              />
              <div>
                <label htmlFor={`schema-field-${key}`} className="text-sm font-medium text-text-primary">
                  {key}
                </label>
                {prop.description && (
                  <p className="text-xs text-text-tertiary mt-0.5">{prop.description}</p>
                )}
              </div>
            </div>
          );
        }

        if (type === 'number') {
          return (
            <div key={key}>
              <label htmlFor={`schema-field-${key}`} className="block text-sm font-medium text-text-primary mb-1">
                {key}
              </label>
              <input
                id={`schema-field-${key}`}
                type="number"
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                disabled={disabled}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:border-blue-500 focus:ring-blue-500"
              />
              {prop.description && (
                <p className="text-xs text-text-tertiary mt-1">{prop.description}</p>
              )}
            </div>
          );
        }

        if (type === 'object' || type === 'array') {
          return (
            <div key={key}>
              <label htmlFor={`schema-field-${key}`} className="block text-sm font-medium text-text-primary mb-1">
                {key}
                <span className="ml-1.5 text-[10px] text-text-muted font-normal">(JSON)</span>
              </label>
              <textarea
                id={`schema-field-${key}`}
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                disabled={disabled}
                placeholder={type === 'array' ? '[]' : '{}'}
                className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:border-blue-500 focus:ring-blue-500 min-h-[80px] resize-y"
              />
              {prop.description && (
                <p className="text-xs text-text-tertiary mt-1">{prop.description}</p>
              )}
            </div>
          );
        }

        // Default: string
        return (
          <div key={key}>
            <label htmlFor={`schema-field-${key}`} className="block text-sm font-medium text-text-primary mb-1">
              {key}
            </label>
            <input
              id={`schema-field-${key}`}
              type="text"
              value={value}
              onChange={(e) => onChange(key, e.target.value)}
              disabled={disabled}
              className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:border-blue-500 focus:ring-blue-500"
            />
            {prop.description && (
              <p className="text-xs text-text-tertiary mt-1">{prop.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function TriggerDialog({ workflowName, isOpen, onClose, onTrigger, isPending, outputSchema, validation }: TriggerDialogProps) {
  const [input, setInput] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Derive schema properties if present
  const schemaProperties = useMemo<Record<string, SchemaProperty> | null>(() => {
    const props = outputSchema?.properties;
    if (props && typeof props === 'object' && Object.keys(props).length > 0) {
      return props as Record<string, SchemaProperty>;
    }
    return null;
  }, [outputSchema]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setInput('');
      if (schemaProperties) {
        // Seed defaults from schema
        const defaults: Record<string, string> = {};
        for (const [key, prop] of Object.entries(schemaProperties)) {
          if (prop.default !== undefined) {
            const t = prop.type ?? 'string';
            if (t === 'boolean') {
              defaults[key] = String(prop.default);
            } else if (t === 'object' || t === 'array') {
              defaults[key] = JSON.stringify(prop.default, null, 2);
            } else {
              defaults[key] = String(prop.default);
            }
          } else {
            defaults[key] = '';
          }
        }
        setFieldValues(defaults);
        setTimeout(() => firstInputRef.current?.focus(), 50);
      } else {
        setFieldValues({});
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    }
  }, [isOpen, schemaProperties]);

  // JSON validation for the raw textarea fallback
  const jsonStatus = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed) return 'empty' as const;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'text' as const;
    try {
      JSON.parse(trimmed);
      return 'valid' as const;
    } catch {
      return 'invalid' as const;
    }
  }, [input]);

  if (!isOpen) return null;

  const handleFieldChange = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const buildSchemaPayload = (): Record<string, unknown> | null => {
    if (!schemaProperties) return null;
    const payload: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schemaProperties)) {
      const raw = fieldValues[key] ?? '';
      const type = prop.type ?? 'string';
      if (raw === '' && prop.default === undefined) continue;
      if (type === 'boolean') {
        payload[key] = raw === 'true';
      } else if (type === 'number') {
        const n = parseFloat(raw);
        if (!isNaN(n)) payload[key] = n;
      } else if (type === 'object' || type === 'array') {
        try {
          payload[key] = raw ? JSON.parse(raw) : type === 'array' ? [] : {};
        } catch {
          // Leave out malformed JSON fields rather than blocking submit
        }
      } else {
        if (raw !== '') payload[key] = raw;
      }
    }
    return payload;
  };

  const handleSubmit = () => {
    if (schemaProperties) {
      const payload = buildSchemaPayload();
      if (payload !== null) onTrigger(payload);
      return;
    }
    // Raw textarea path
    const trimmed = input.trim();
    if (!trimmed) return;
    let payload: Record<string, unknown>;
    if (jsonStatus === 'valid') {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } else {
      payload = { prompt: trimmed };
    }
    onTrigger(payload);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
    if (e.key === 'Tab' && !schemaProperties) {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setInput(input.substring(0, start) + '  ' + input.substring(end));
      setTimeout(() => ta.setSelectionRange(start + 2, start + 2), 0);
    }
  };

  const statusIndicator =
    jsonStatus === 'valid'
      ? { text: 'Valid JSON', className: 'text-green-600 dark:text-green-400' }
      : jsonStatus === 'invalid'
        ? { text: 'Invalid JSON', className: 'text-red-600 dark:text-red-400' }
        : jsonStatus === 'text'
          ? { text: 'Free text', className: 'text-text-tertiary' }
          : null;

  // Schema-driven: submit is always enabled (empty payload is valid)
  const schemaSubmitDisabled = isPending;
  // Raw textarea: require non-empty, valid-ish input
  const rawSubmitDisabled = !schemaProperties && (!input.trim() || isPending || jsonStatus === 'invalid');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-subtle rounded-xl w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="p-5 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">Trigger: {workflowName}</h3>
          <p className="text-xs text-text-secondary mt-1">
            {schemaProperties
              ? 'Fill in the fields below to provide input for the workflow.'
              : 'Enter a prompt or JSON payload for the workflow.'}
          </p>
        </div>

        <div className="p-5 max-h-[60vh] overflow-y-auto space-y-4">
          {validation && !validation.valid && (
            <div className="bg-red-950/20 border border-red-500/30 rounded-lg p-3 space-y-1">
              <div className="text-xs font-medium text-red-400">
                {validation.summary}
              </div>
              {validation.errors.slice(0, 5).map((err, i) => (
                <div key={i} className="text-[11px] text-red-400/80">• {err}</div>
              ))}
            </div>
          )}

          {validation && validation.valid && validation.warnings.length > 0 && (
            <div className="bg-amber-950/20 border border-amber-500/30 rounded-lg p-3 space-y-1">
              <div className="text-xs font-medium text-amber-400">
                {validation.warnings.length} warning{validation.warnings.length !== 1 ? 's' : ''}
              </div>
              {validation.warnings.slice(0, 5).map((w, i) => (
                <div key={i} className="text-[11px] text-amber-400/80">• {w}</div>
              ))}
            </div>
          )}

          {schemaProperties ? (
            <SchemaForm
              properties={schemaProperties}
              values={fieldValues}
              onChange={handleFieldChange}
              disabled={isPending}
            />
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Enter input for the workflow..."
                className={`w-full bg-surface border rounded-lg px-4 py-3 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 min-h-[140px] resize-y ${
                  jsonStatus === 'invalid'
                    ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                    : 'border-border-subtle focus:border-blue-500 focus:ring-blue-500'
                }`}
                disabled={isPending}
              />
              <div className="flex items-center justify-between mt-2">
                {statusIndicator ? (
                  <span className={`text-[10px] font-medium ${statusIndicator.className}`}>{statusIndicator.text}</span>
                ) : (
                  <span />
                )}
                <span className="text-[10px] text-text-muted">
                  {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to run
                </span>
              </div>
            </>
          )}
        </div>

        <div className="p-5 border-t border-border flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={schemaProperties ? schemaSubmitDisabled : rawSubmitDisabled}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
