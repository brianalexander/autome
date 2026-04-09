import { useState, useRef, useEffect, useMemo } from 'react';

interface SchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
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

/**
 * Build a template JSON object from a JSON Schema, using defaults or
 * placeholder values so the user has something to fill in.
 */
function buildTemplate(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, SchemaProperty> | undefined;
  if (!props) return {};
  const required = (schema.required || []) as string[];
  const result: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.default !== undefined) {
      result[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      result[key] = prop.enum[0];
    } else {
      switch (prop.type) {
        case 'number':
        case 'integer':
          result[key] = 0;
          break;
        case 'boolean':
          result[key] = false;
          break;
        case 'array':
          result[key] = [];
          break;
        case 'object':
          result[key] = {};
          break;
        default:
          result[key] = required.includes(key) ? '' : '';
          break;
      }
    }
  }
  return result;
}

/**
 * Validate a payload against the schema's required fields.
 * Returns an array of error strings (empty = valid).
 */
function validatePayload(payload: Record<string, unknown>, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const required = (schema.required || []) as string[];
  const props = (schema.properties || {}) as Record<string, SchemaProperty>;

  for (const key of required) {
    const val = payload[key];
    if (val === undefined || val === null || val === '') {
      errors.push(`"${key}" is required`);
    }
  }

  // Type checks for provided values
  for (const [key, prop] of Object.entries(props)) {
    const val = payload[key];
    if (val === undefined || val === null || val === '') continue;
    if (prop.type === 'number' || prop.type === 'integer') {
      if (typeof val !== 'number') errors.push(`"${key}" should be a number`);
    } else if (prop.type === 'boolean') {
      if (typeof val !== 'boolean') errors.push(`"${key}" should be a boolean`);
    } else if (prop.type === 'array') {
      if (!Array.isArray(val)) errors.push(`"${key}" should be an array`);
    }
    if (prop.enum && prop.enum.length > 0 && !prop.enum.includes(val)) {
      errors.push(`"${key}" must be one of: ${prop.enum.map(String).join(', ')}`);
    }
  }

  return errors;
}

export function TriggerDialog({ workflowName, isOpen, onClose, onTrigger, isPending, outputSchema, validation }: TriggerDialogProps) {
  const [input, setInput] = useState('');
  const [schemaErrors, setSchemaErrors] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasSchema = !!(outputSchema?.properties && Object.keys(outputSchema.properties as object).length > 0);

  // Build template JSON when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSchemaErrors([]);
      if (hasSchema && outputSchema) {
        const template = buildTemplate(outputSchema);
        setInput(JSON.stringify(template, null, 2));
      } else {
        setInput('');
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [isOpen, hasSchema, outputSchema]);

  // Live JSON validation
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

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    let payload: Record<string, unknown>;
    if (jsonStatus === 'valid') {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } else if (jsonStatus === 'text') {
      payload = { prompt: trimmed };
    } else {
      return; // invalid JSON, don't submit
    }

    // Validate against schema if present
    if (hasSchema && outputSchema && jsonStatus === 'valid') {
      const errors = validatePayload(payload, outputSchema);
      if (errors.length > 0) {
        setSchemaErrors(errors);
        return;
      }
    }

    setSchemaErrors([]);
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
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setInput(input.substring(0, start) + '  ' + input.substring(end));
      setTimeout(() => ta.setSelectionRange(start + 2, start + 2), 0);
    }
  };

  // Build description hints from schema
  const fieldHints = useMemo(() => {
    if (!hasSchema || !outputSchema) return null;
    const props = outputSchema.properties as Record<string, SchemaProperty>;
    const required = (outputSchema.required || []) as string[];
    const hints: { key: string; type: string; desc?: string; req: boolean }[] = [];
    for (const [key, prop] of Object.entries(props)) {
      hints.push({
        key,
        type: prop.type || 'string',
        desc: prop.description,
        req: required.includes(key),
      });
    }
    return hints.length > 0 ? hints : null;
  }, [hasSchema, outputSchema]);

  const statusIndicator =
    jsonStatus === 'valid'
      ? { text: 'Valid JSON', className: 'text-green-600 dark:text-green-400' }
      : jsonStatus === 'invalid'
        ? { text: 'Invalid JSON', className: 'text-red-600 dark:text-red-400' }
        : jsonStatus === 'text'
          ? { text: 'Free text', className: 'text-text-tertiary' }
          : null;

  const submitDisabled = !input.trim() || isPending || jsonStatus === 'invalid';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-subtle rounded-xl w-full max-w-lg mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">Trigger: {workflowName}</h3>
          <p className="text-xs text-text-secondary mt-1">
            {hasSchema
              ? 'Edit the JSON payload below. Fields are pre-populated from the trigger schema.'
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

          {schemaErrors.length > 0 && (
            <div className="bg-red-950/20 border border-red-500/30 rounded-lg p-3 space-y-1">
              <div className="text-xs font-medium text-red-400">Validation failed</div>
              {schemaErrors.map((err, i) => (
                <div key={i} className="text-[11px] text-red-400/80">• {err}</div>
              ))}
            </div>
          )}

          {/* Field hints from schema */}
          {fieldHints && (
            <div className="bg-surface border border-border rounded-lg p-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5">Expected fields</div>
              <div className="space-y-1">
                {fieldHints.map((h) => (
                  <div key={h.key} className="flex items-baseline gap-2 text-xs">
                    <code className="text-blue-400 font-mono text-[11px]">{h.key}</code>
                    <span className="text-text-muted text-[10px]">{h.type}</span>
                    {h.req && <span className="text-red-400 text-[10px]">required</span>}
                    {h.desc && <span className="text-text-tertiary text-[10px] truncate">{h.desc}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); setSchemaErrors([]); }}
            onKeyDown={handleKeyDown}
            placeholder="Enter input for the workflow..."
            className={`w-full bg-surface border rounded-lg px-4 py-3 text-sm text-text-primary font-mono focus:outline-none focus:ring-1 min-h-[160px] resize-y ${
              jsonStatus === 'invalid' || schemaErrors.length > 0
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                : 'border-border-subtle focus:border-blue-500 focus:ring-blue-500'
            }`}
            disabled={isPending}
          />
          <div className="flex items-center justify-between">
            {statusIndicator ? (
              <span className={`text-[10px] font-medium ${statusIndicator.className}`}>{statusIndicator.text}</span>
            ) : (
              <span />
            )}
            <span className="text-[10px] text-text-muted">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to run
            </span>
          </div>
        </div>

        <div className="p-5 border-t border-border flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitDisabled}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 transition-colors"
          >
            {isPending ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
