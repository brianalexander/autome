import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { useNodeTypes } from '../../hooks/queries';
import {
  isTriggerType,
  type StageDefinition,
  type EdgeDefinition,
  type WorkflowDefinition,
} from '../../lib/api';
import { SchemaForm } from './SchemaForm';
import { CodeEditor } from './CodeEditor';
import { Field } from './ConfigPanelShared';
import { AgentConfigSection } from './AgentConfigSection';
import { AdvancedStageConfig } from './AdvancedStageConfig';

// Re-export EdgeConfigPanel so existing import sites (WorkflowEditor.tsx) don't break.
export { EdgeConfigPanel } from './EdgeConfigPanel';

const MAX_SCHEMA_DEPTH = 4;

/** Recursively render JSON Schema properties as a tree. */
function SchemaPropertiesTree({ properties, depth }: { properties: Record<string, Record<string, unknown>>; depth: number }) {
  if (depth > MAX_SCHEMA_DEPTH) return null;
  return (
    <div className="space-y-0.5" style={{ marginLeft: `${depth * 12}px` }}>
      {Object.entries(properties).map(([key, propSchema]) => {
        const propType = propSchema.type as string | undefined;
        const propDesc = propSchema.description as string | undefined;
        const nestedProps = propSchema.properties as Record<string, Record<string, unknown>> | undefined;
        // For arrays, check if items have properties
        const itemsSchema = propSchema.items as Record<string, unknown> | undefined;
        const itemProps = itemsSchema?.properties as Record<string, Record<string, unknown>> | undefined;

        return (
          <div key={key}>
            <div className="flex items-baseline gap-2 text-xs">
              <code className="text-blue-400 font-mono text-[10px]">.{key}</code>
              {propType && <span className="text-text-muted text-[10px]">{propType}{itemProps ? '[]' : ''}</span>}
              {propDesc && <span className="text-text-tertiary text-[10px]">— {propDesc}</span>}
            </div>
            {nestedProps && <SchemaPropertiesTree properties={nestedProps} depth={depth + 1} />}
            {itemProps && <SchemaPropertiesTree properties={itemProps} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}

interface ConfigPanelProps {
  stage: StageDefinition;
  definition: WorkflowDefinition;
  onSave: (updated: StageDefinition) => void;
  onDelete: () => void;
  onClose: () => void;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
}

export function ConfigPanel({ stage, definition, onSave, onDelete, onClose, onDefinitionChange }: ConfigPanelProps) {
  const { data: specs } = useNodeTypes();

  // Local edit state — updated synchronously on every keystroke for responsiveness.
  // Only reset when a DIFFERENT stage is selected (stage.id changes), not when the
  // parent's version of the same stage updates (which would cause the cursor to jump).
  const [editState, setEditState] = useState<StageDefinition>(stage);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  // The debounced flush receives the latest value via a ref so the closure never goes stale.
  const pendingValueRef = useRef<StageDefinition>(stage);

  // ID editing state
  const [idDraft, setIdDraft] = useState<string>(stage.id);
  const ID_FORMAT_RE = /^[a-z][a-z0-9_]*$/;

  useEffect(() => {
    setEditState(stage);
    pendingValueRef.current = stage;
    setIdDraft(stage.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.id]);

  // Stage config is Record<string, unknown> at the type level, but we know the actual shape by node type
  const cfg = (editState.config || {}) as {
    // Webhook trigger config
    secret?: string;
    payload_filter?: string;
    // Cron trigger config
    schedule?: string;
    // Gate config
    type?: string;
    message?: string;
    condition?: string;
    timeout_action?: string;
    timeout_minutes?: number;
    [key: string]: unknown;
  };
  const debouncedFlush = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      // structuredClone happens ONCE per debounce period, not on every keystroke.
      onSave(structuredClone(pendingValueRef.current));
    }, 300);
  }, [onSave]);

  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  const update = useCallback((path: string, value: unknown) => {
    setEditState((prev) => {
      const parts = path.split('.');
      // Shallow-clone each level along the path so we don't mutate existing objects.
      const next = { ...prev } as Record<string, unknown>;
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        const child = obj[parts[i]];
        obj[parts[i]] = child !== null && typeof child === 'object' ? { ...(child as Record<string, unknown>) } : {};
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      if (value === undefined) {
        delete obj[parts[parts.length - 1]];
      } else {
        obj[parts[parts.length - 1]] = value;
      }
      pendingValueRef.current = next as unknown as StageDefinition;
      return next as unknown as StageDefinition;
    });
    debouncedFlush();
  }, [debouncedFlush]);

  // Compute upstream output schema(s) for autocomplete and reference
  const { upstreamSchema, upstreamSchemaMode } = useMemo(() => {
    const incomingEdges = definition.edges.filter(e => e.target === stage.id && (e.trigger || 'on_success') === 'on_success');
    if (incomingEdges.length === 0) return { upstreamSchema: undefined, upstreamSchemaMode: undefined };

    const inputMode = (editState.input_mode as string) || 'queue';

    // Collect each upstream's output schema, keyed by source stage ID
    const sourceSchemas: Record<string, Record<string, unknown>> = {};
    for (const edge of incomingEdges) {
      const sourceStage = definition.stages.find(s => s.id === edge.source);
      if (!sourceStage) continue;
      const sourceConfig = (sourceStage.config || {}) as Record<string, unknown>;
      let schema = sourceConfig.output_schema as Record<string, unknown> | undefined;
      // For http-request nodes, response_schema is the output schema
      if (!schema) schema = sourceConfig.response_schema as Record<string, unknown> | undefined;
      // Fallback to node type spec's default
      if (!schema && specs) {
        const spec = specs.find(s => s.id === sourceStage.type);
        schema = spec?.defaultConfig?.output_schema as Record<string, unknown> | undefined;
      }
      sourceSchemas[edge.source] = schema || { type: 'object' };
    }

    if (Object.keys(sourceSchemas).length === 0) return { upstreamSchema: undefined, upstreamSchemaMode: undefined };

    // Build the combined schema — always namespaced by source ID
    const merged: Record<string, unknown> = {
      type: 'object',
      properties: sourceSchemas,
    };

    return { upstreamSchema: merged, upstreamSchemaMode: inputMode as 'queue' | 'fan_in' };
  }, [definition, stage.id, editState.input_mode, specs]);

  // For trigger stages: scan outgoing edge prompt_templates for expected payload fields
  const expectedPayloadFields = useMemo(() => {
    if (!isTriggerType(stage.type)) return [];
    const outgoingEdges = definition.edges.filter((e) => e.source === stage.id);
    const fields = new Set<string>();
    for (const edge of outgoingEdges) {
      const tpl = edge.prompt_template || '';
      for (const m of tpl.matchAll(/\{\{\s*trigger\.payload\.(\w+)\s*\}\}/g)) {
        fields.add(m[1]);
      }
      if (/\{\{\s*trigger\.payload\s*\}\}/.test(tpl)) fields.add('*');
    }
    return Array.from(fields);
  }, [stage.type, stage.id, definition]);

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between flex-shrink-0">
        <h3 className="font-semibold text-sm">Configure: {editState.id}</h3>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors p-1" title="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {/* Stage ID (editable) */}
        <Field label="Stage ID">
          {(() => {
            const otherIds = definition.stages.filter((s) => s.id !== stage.id).map((s) => s.id);
            const formatError = idDraft && !ID_FORMAT_RE.test(idDraft);
            const uniqueError = !formatError && idDraft !== stage.id && otherIds.includes(idDraft);
            const hasError = !!(formatError || uniqueError);
            return (
              <>
                <input
                  value={idDraft}
                  onChange={(e) => setIdDraft(e.target.value)}
                  onBlur={() => {
                    const trimmed = idDraft.trim();
                    if (!trimmed || !ID_FORMAT_RE.test(trimmed)) {
                      setIdDraft(stage.id);
                      return;
                    }
                    const otherIdsBlur = definition.stages.filter((s) => s.id !== stage.id).map((s) => s.id);
                    if (otherIdsBlur.includes(trimmed)) {
                      setIdDraft(stage.id);
                      return;
                    }
                    if (trimmed === stage.id) return;
                    // Apply rename: update stage ID and all edge references
                    if (onDefinitionChange) {
                      const renamedStage: StageDefinition = { ...editState, id: trimmed };
                      onDefinitionChange({
                        ...definition,
                        stages: definition.stages.map((s) => (s.id === stage.id ? renamedStage : s)),
                        edges: definition.edges.map((e) => ({
                          ...e,
                          source: e.source === stage.id ? trimmed : e.source,
                          target: e.target === stage.id ? trimmed : e.target,
                          id: (() => {
                            // Rewrite edge IDs that embedded the old stage ID
                            const src = e.source === stage.id ? trimmed : e.source;
                            const tgt = e.target === stage.id ? trimmed : e.target;
                            if (e.source === stage.id || e.target === stage.id) {
                              return `edge_${src}_${tgt}`;
                            }
                            return e.id;
                          })(),
                        })),
                      });
                    }
                  }}
                  className={`input-field font-mono text-xs${hasError ? ' border-red-500 focus:ring-red-500' : ''}`}
                  spellCheck={false}
                />
                {formatError && (
                  <p className="text-[10px] text-red-500 mt-1">
                    Must start with a letter and contain only lowercase letters, numbers, and underscores.
                  </p>
                )}
                {uniqueError && (
                  <p className="text-[10px] text-red-500 mt-1">
                    This ID is already used by another stage.
                  </p>
                )}
              </>
            );
          })()}
        </Field>

        {/* Stage Type */}
        <Field label="Type">
          <span className="text-sm capitalize">{editState.type}</span>
        </Field>

        {/* Node Label */}
        <Field label="Label">
          <input
            value={editState.label || ''}
            onChange={(e) => update('label', e.target.value || undefined)}
            className="input-field"
            placeholder={editState.type
              .split('-')
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ')}
          />
        </Field>

        {/* Node Description */}
        <Field label="Description">
          <input
            value={editState.description || ''}
            onChange={(e) => update('description', e.target.value || undefined)}
            className="input-field"
            placeholder="Short description of what this node does"
          />
        </Field>

        {/* Upstream input schema reference */}
        {upstreamSchema?.properties != null && !isTriggerType(editState.type) && editState.type !== 'agent' && (
          <div className="bg-surface-secondary/50 border border-border-subtle rounded-lg p-3 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Input</div>
              {upstreamSchemaMode && Object.keys(upstreamSchema.properties as Record<string, unknown>).length > 1 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-muted">
                  {upstreamSchemaMode === 'fan_in' ? 'all arrive together' : 'one at a time'}
                </span>
              )}
            </div>
            <div className="space-y-2">
              {Object.entries(upstreamSchema.properties as Record<string, Record<string, unknown>>).map(([sourceId, sourceSchema]) => (
                <div key={sourceId}>
                  <div className="text-[10px] font-mono text-text-muted mb-1">
                    input.{sourceId}
                    {sourceSchema.properties == null && (
                      <span className="text-text-tertiary ml-1">
                        {(sourceSchema.type as string) || 'object'}
                      </span>
                    )}
                  </div>
                  {sourceSchema.properties != null && (
                    <SchemaPropertiesTree properties={sourceSchema.properties as Record<string, Record<string, unknown>>} depth={1} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agent-specific config */}
        {editState.type === 'agent' && (
          <AgentConfigSection
            stage={editState}
            definition={definition}
            update={update}
            onDefinitionChange={onDefinitionChange}
          />
        )}

        {/* === Manual Trigger config === */}
        {editState.type === 'manual-trigger' && (
          <>
            <ExpectedInputsBlock fields={expectedPayloadFields} />

            <div className="bg-surface-secondary rounded-lg p-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">Usage</div>
              <p className="text-xs text-text-secondary">
                Click <strong>Run</strong> on the workflow page, or use the API:
              </p>
              <pre className="text-[11px] text-text-secondary font-mono mt-2 whitespace-pre-wrap">{`POST /api/workflows/${definition.id}/trigger
{ "payload": { "your_field": "your_value" } }`}</pre>
              <p className="text-[10px] text-text-tertiary mt-2">
                The payload can be any JSON. Access fields via{' '}
                <code className="text-blue-600 dark:text-blue-300 bg-surface-tertiary px-1 rounded">
                  {'{{ trigger.payload.your_field }}'}
                </code>{' '}
                in context templates.
              </p>
            </div>
          </>
        )}

        {/* === Webhook Trigger config === */}
        {editState.type === 'webhook-trigger' && (
          <>
            <ExpectedInputsBlock fields={expectedPayloadFields} />

            <div className="border-t border-border pt-4">
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
                Webhook Configuration
              </div>
            </div>

            <Field label="Webhook URL">
              <div className="flex items-center gap-2">
                <code className="text-xs text-violet-600 dark:text-violet-300 bg-surface-secondary rounded px-2 py-1.5 flex-1 overflow-x-auto font-mono break-all">
                  {`${window.location.origin}/api/webhooks/${definition.id}`}
                </code>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(`${window.location.origin}/api/webhooks/${definition.id}`)
                  }
                  className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-1 bg-surface-tertiary rounded flex-shrink-0"
                >
                  Copy
                </button>
              </div>
            </Field>

            <Field label="Secret (optional)">
              <input
                value={(cfg.secret as string) || ''}
                onChange={(e) => update('config.secret', e.target.value || undefined)}
                className="input-field font-mono"
                placeholder="Leave empty for no authentication"
              />
              <p className="text-[10px] text-text-tertiary mt-1">
                If set, callers must include <code className="font-mono text-text-secondary">x-webhook-secret</code>{' '}
                header.
              </p>
            </Field>

            <Field label="Payload Filter (optional)">
              <input
                value={(cfg.payload_filter as string) || ''}
                onChange={(e) => update('config.payload_filter', e.target.value || undefined)}
                className="input-field font-mono text-xs"
                placeholder="payload.action === 'created'"
              />
              <p className="text-[10px] text-text-tertiary mt-1">
                JS expression evaluated against the incoming payload. Workflow only triggers if truthy.
              </p>
            </Field>

            <div className="bg-surface-secondary rounded-lg p-3 space-y-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">How it works</div>
              <p className="text-xs text-text-secondary">
                POST any JSON body to the webhook URL. The entire body becomes{' '}
                <code className="text-violet-600 dark:text-violet-300 bg-surface-tertiary px-1 rounded">
                  trigger.payload
                </code>{' '}
                in your workflow's context templates.
              </p>
              <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap">{`curl -X POST ${window.location.origin}/api/webhooks/${definition.id} \\
  -H 'Content-Type: application/json'${
    cfg.secret
      ? ` \\
  -H 'x-webhook-secret: ${cfg.secret}'`
      : ''
  } \\
  -d '{"prompt": "Analyze this ticket"}'`}</pre>
            </div>
          </>
        )}

        {/* === Cron Trigger config === */}
        {editState.type === 'cron-trigger' && (
          <>
            <Field label="Schedule" description="How often the workflow should run">
              <input
                value={(cfg.schedule as string) || ''}
                onChange={(e) => update('config.schedule', e.target.value || undefined)}
                className="input-field font-mono"
                placeholder="5m"
              />
              <p className="text-[10px] text-text-tertiary mt-1">
                Simple formats: <code className="font-mono">5m</code>, <code className="font-mono">1h</code>,{' '}
                <code className="font-mono">30s</code>. Cron expressions:{' '}
                <code className="font-mono">*/5 * * * *</code>
              </p>
            </Field>

            <div className="bg-surface-secondary rounded-lg p-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">
                How it works
              </div>
              <p className="text-xs text-text-secondary">
                When the workflow is active, it will be triggered automatically on the specified schedule. Each trigger
                creates a new workflow instance.
              </p>
              <p className="text-[10px] text-text-tertiary mt-2">
                The trigger payload includes the schedule and timestamp. Access via{' '}
                <code className="text-blue-600 dark:text-blue-300 bg-surface-tertiary px-1 rounded">
                  {'{{ trigger.payload.schedule }}'}
                </code>
              </p>
            </div>
          </>
        )}

        {/* Gate-specific config */}
        {editState.type === 'gate' && (
          <>
            <Field label="Gate Type">
              <select
                value={cfg.type || 'manual'}
                onChange={(e) => update('config.type', e.target.value)}
                className="input-field"
              >
                <option value="manual">Manual (human approval)</option>
                <option value="conditional">Conditional (JS expression)</option>
                <option value="auto">Auto (always passes)</option>
              </select>
            </Field>

            <Field label="Message">
              <input
                value={cfg.message || ''}
                onChange={(e) => update('config.message', e.target.value)}
                className="input-field"
                placeholder="Review before proceeding"
              />
            </Field>

            {cfg.type === 'conditional' && (
              <Field label="Condition">
                <input
                  value={cfg.condition || ''}
                  onChange={(e) => update('config.condition', e.target.value)}
                  className="input-field font-mono text-xs"
                  placeholder="context.stages['analyzer'].latest.score > 0.8"
                />
              </Field>
            )}

            <Field label="Timeout (minutes)">
              <input
                type="number"
                value={cfg.timeout_minutes ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  update('config.timeout_minutes', isNaN(val) ? undefined : val);
                }}
                className="input-field w-24"
                min={1}
                placeholder="∞"
              />
            </Field>

            <Field label="Timeout Action">
              <select
                value={cfg.timeout_action || 'reject'}
                onChange={(e) => update('config.timeout_action', e.target.value)}
                className="input-field"
              >
                <option value="approve">Auto-approve on timeout</option>
                <option value="reject">Reject on timeout</option>
              </select>
            </Field>
          </>
        )}

        {/* Generic config for new node types — driven by SchemaForm */}
        {!['agent', 'gate', 'manual-trigger', 'webhook-trigger', 'cron-trigger'].includes(editState.type) && (
          <GenericNodeConfig
            editState={editState}
            onUpdate={(updated) => {
              pendingValueRef.current = updated;
              setEditState(updated);
              debouncedFlush();
            }}
            upstreamSchema={upstreamSchema}
            nodeType={editState.type}
          />
        )}

        {/* --- Advanced: Fan-in, Retry, Map (all step types) --- */}
        {!isTriggerType(editState.type) && (
          <AdvancedStageConfig editState={editState} definition={definition} onUpdate={update} />
        )}
      </div>
    </div>
  );
}

function ExpectedInputsBlock({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="bg-surface-secondary rounded-lg p-3">
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">
        Expected Inputs
      </div>
      <p className="text-[10px] text-text-tertiary mb-2">
        Downstream stages expect these fields in the trigger payload:
      </p>
      {fields.includes('*') ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-teal-600 dark:text-teal-300 bg-surface-tertiary px-2 py-0.5 rounded">
            payload
          </span>
          <span className="text-[10px] text-text-tertiary">entire payload object used directly</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {fields.map((f) => (
            <span
              key={f}
              className="text-xs font-mono text-teal-600 dark:text-teal-300 bg-surface-tertiary px-2 py-0.5 rounded"
            >
              {f}
            </span>
          ))}
        </div>
      )}
      <pre className="text-[11px] text-text-tertiary font-mono mt-2 whitespace-pre-wrap">
        {fields.includes('*')
          ? '{ "any": "data", "goes": "here" }'
          : `{ ${fields
              .filter((f) => f !== '*')
              .map((f) => `"${f}": "..."`)
              .join(', ')} }`}
      </pre>
    </div>
  );
}

/** Schema-driven config for non-specialized node types */
function GenericNodeConfig({
  editState,
  onUpdate,
  upstreamSchema,
  nodeType,
}: {
  editState: StageDefinition;
  onUpdate: (s: StageDefinition) => void;
  upstreamSchema?: Record<string, unknown>;
  nodeType?: string;
}) {
  const { data: specs } = useNodeTypes();
  const spec = specs?.find((s) => s.id === editState.type);

  const handleChange = useCallback(
    (config: Record<string, unknown>) => {
      onUpdate({ ...editState, config });
    },
    [editState, onUpdate],
  );

  if (!spec) {
    return <div className="text-xs text-text-tertiary py-2">Unknown node type: {editState.type}</div>;
  }

  return (
    <>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">{spec.name} Configuration</div>
      <SchemaForm
        schema={spec.configSchema}
        value={(editState.config || {}) as Record<string, unknown>}
        onChange={handleChange}
        outputSchema={upstreamSchema}
        nodeType={nodeType}
        returnSchema={(editState.config as Record<string, unknown>)?.output_schema as Record<string, unknown> | undefined}
      />
    </>
  );
}

