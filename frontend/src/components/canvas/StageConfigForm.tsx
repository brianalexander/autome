import { useCallback } from 'react';
import { useNodeTypes } from '../../hooks/queries';
import { type StageDefinition, type WorkflowDefinition } from '../../lib/api';
import { SchemaForm } from './SchemaForm';
import { CodeEditor } from './CodeEditor';
import { Field } from './ConfigPanelShared';
import { AgentConfigSection } from './AgentConfigSection';

interface StageConfigFormProps {
  stage: StageDefinition;
  onChange: (updated: StageDefinition) => void;
  readonly?: boolean;
  /** Optional — when provided, enables features that need workflow context.
   *  When omitted, workflow-dependent features (like cycle behavior detection and webhook URLs) are hidden. */
  definition?: WorkflowDefinition;
  /** For trigger stages: field names that downstream edges reference via trigger.payload.X.
   *  Computed from outgoing edges — only ConfigPanel can provide this. */
  expectedPayloadFields?: string[];
}

/**
 * Renders only the type-specific config sections for a stage.
 * Does NOT include workflow-contextual sections like upstream schema, edge config,
 * stage ID/label/readme fields, or fan-in/retry/map advanced config.
 * Those live in ConfigPanel.
 *
 * Consumers call onChange with the full updated StageDefinition.
 */
export function StageConfigForm({ stage, onChange, readonly, definition, expectedPayloadFields }: StageConfigFormProps) {
  // Path-based update helper — mirrors ConfigPanel's internal `update()` but
  // calls onChange with the full updated stage instead of using internal state.
  const update = useCallback(
    (path: string, value: unknown) => {
      if (readonly) return;
      const parts = path.split('.');
      const next = { ...stage } as Record<string, unknown>;
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
      onChange(next as unknown as StageDefinition);
    },
    [stage, onChange, readonly],
  );

  const cfg = (stage.config || {}) as {
    secret?: string;
    payload_filter?: string;
    schedule?: string;
    type?: string;
    message?: string;
    condition?: string;
    timeout_action?: string;
    timeout_minutes?: number;
    output_schema?: unknown;
    [key: string]: unknown;
  };

  return (
    <>
      {/* Agent-specific config */}
      {stage.type === 'agent' && (
        <AgentConfigSection
          stage={stage}
          // When no definition is provided, supply a minimal stub so AgentConfigSection's
          // canStageCycle check finds no cycle edges and gracefully hides that section.
          definition={definition ?? ({ id: '', stages: [stage], edges: [] } as unknown as WorkflowDefinition)}
          update={update}
        />
      )}

      {/* === Manual Trigger config === */}
      {stage.type === 'manual-trigger' && (
        <>
          <Field
            label="Output Schema"
            required
            description="JSON Schema describing the trigger payload. Defines the trigger form and enables type hints for downstream nodes."
          >
            <CodeEditor
              value={
                typeof cfg.output_schema === 'object' && cfg.output_schema
                  ? JSON.stringify(cfg.output_schema, null, 2)
                  : (cfg.output_schema as string) || ''
              }
              onChange={(val) => {
                if (readonly) return;
                try {
                  const parsed = JSON.parse(val);
                  update('config.output_schema', parsed);
                } catch {
                  update('config.output_schema', val || undefined);
                }
              }}
              readOnly={readonly}
              editorMode="json"
              minHeight="100px"
            />
          </Field>

          {expectedPayloadFields && <ExpectedInputsBlock fields={expectedPayloadFields} />}

          {definition && (
            <div className="bg-surface-secondary rounded-lg p-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium mb-2">Usage</div>
              <p className="text-xs text-text-secondary">
                Click <strong>Run</strong> on the workflow page, or use the API:
              </p>
              <pre className="text-[11px] text-text-secondary font-mono mt-2 whitespace-pre-wrap">{`POST /api/workflows/${definition.id}/trigger
{ "payload": { "your_field": "your_value" } }`}</pre>
              <p className="text-[10px] text-text-tertiary mt-2">
                Downstream edges reference trigger output via{' '}
                <code className="text-blue-600 dark:text-blue-300 bg-surface-tertiary px-1 rounded">
                  {'{{ output.your_field }}'}
                </code>{' '}
                in prompt templates.
              </p>
            </div>
          )}
        </>
      )}

      {/* === Webhook Trigger config === */}
      {stage.type === 'webhook-trigger' && (
        <>
          <Field
            label="Output Schema"
            required
            description="JSON Schema describing the webhook payload. Validates incoming payloads and enables type hints for downstream nodes."
          >
            <CodeEditor
              value={
                typeof cfg.output_schema === 'object' && cfg.output_schema
                  ? JSON.stringify(cfg.output_schema, null, 2)
                  : (cfg.output_schema as string) || ''
              }
              onChange={(val) => {
                if (readonly) return;
                try {
                  const parsed = JSON.parse(val);
                  update('config.output_schema', parsed);
                } catch {
                  update('config.output_schema', val || undefined);
                }
              }}
              readOnly={readonly}
              editorMode="json"
              minHeight="100px"
            />
          </Field>

          {expectedPayloadFields && <ExpectedInputsBlock fields={expectedPayloadFields} />}

          <div className="border-t border-border pt-4">
            <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
              Webhook Configuration
            </div>
          </div>

          {definition && (
            <Field label="Webhook URL">
              <div className="flex items-center gap-2">
                <code className="text-xs text-violet-600 dark:text-violet-300 bg-surface-secondary rounded px-2 py-1.5 flex-1 overflow-x-auto font-mono break-all">
                  {`${window.location.origin}/api/webhooks/${definition.id}`}
                </code>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${window.location.origin}/api/webhooks/${definition.id}`,
                    )
                  }
                  className="text-[10px] text-text-secondary hover:text-text-primary px-1.5 py-1 bg-surface-tertiary rounded flex-shrink-0"
                >
                  Copy
                </button>
              </div>
            </Field>
          )}

          <Field label="Secret (optional)">
            <input
              value={(cfg.secret as string) || ''}
              onChange={(e) => update('config.secret', e.target.value || undefined)}
              disabled={readonly}
              className={`input-field font-mono${readonly ? ' opacity-60 cursor-default' : ''}`}
              placeholder="Leave empty for no authentication"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              If set, callers must include{' '}
              <code className="font-mono text-text-secondary">x-webhook-secret</code> header.
            </p>
          </Field>

          <Field label="Payload Filter (optional)">
            <input
              value={(cfg.payload_filter as string) || ''}
              onChange={(e) => update('config.payload_filter', e.target.value || undefined)}
              disabled={readonly}
              className={`input-field font-mono text-xs${readonly ? ' opacity-60 cursor-default' : ''}`}
              placeholder="payload.action === 'created'"
            />
            <p className="text-[10px] text-text-tertiary mt-1">
              JS expression evaluated against the incoming payload. Workflow only triggers if truthy.
            </p>
          </Field>

          {definition && (
            <div className="bg-surface-secondary rounded-lg p-3 space-y-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">How it works</div>
              <p className="text-xs text-text-secondary">
                POST any JSON body to the webhook URL. The entire body becomes the trigger's output. Downstream edges
                reference fields via{' '}
                <code className="text-violet-600 dark:text-violet-300 bg-surface-tertiary px-1 rounded">
                  {'{{ output.field }}'}
                </code>
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
          )}
        </>
      )}

      {/* === Cron Trigger config === */}
      {stage.type === 'cron-trigger' && (
        <>
          <Field label="Schedule" description="How often the workflow should run">
            <input
              value={(cfg.schedule as string) || ''}
              onChange={(e) => update('config.schedule', e.target.value || undefined)}
              disabled={readonly}
              className={`input-field font-mono${readonly ? ' opacity-60 cursor-default' : ''}`}
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
                {'{{ output.schedule }}'}
              </code>
            </p>
          </div>
        </>
      )}

      {/* Gate-specific config */}
      {stage.type === 'gate' && (
        <>
          <Field label="Gate Type">
            <select
              value={cfg.type || 'manual'}
              onChange={(e) => update('config.type', e.target.value)}
              disabled={readonly}
              className={`input-field${readonly ? ' opacity-60 cursor-default' : ''}`}
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
              disabled={readonly}
              className={`input-field${readonly ? ' opacity-60 cursor-default' : ''}`}
              placeholder="Review before proceeding"
            />
          </Field>

          {cfg.type === 'conditional' && (
            <Field label="Condition">
              <input
                value={cfg.condition || ''}
                onChange={(e) => update('config.condition', e.target.value)}
                disabled={readonly}
                className={`input-field font-mono text-xs${readonly ? ' opacity-60 cursor-default' : ''}`}
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
              disabled={readonly}
              className={`input-field w-24${readonly ? ' opacity-60 cursor-default' : ''}`}
              min={1}
              placeholder="∞"
            />
          </Field>

          <Field label="Timeout Action">
            <select
              value={cfg.timeout_action || 'reject'}
              onChange={(e) => update('config.timeout_action', e.target.value)}
              disabled={readonly}
              className={`input-field${readonly ? ' opacity-60 cursor-default' : ''}`}
            >
              <option value="approve">Auto-approve on timeout</option>
              <option value="reject">Reject on timeout</option>
            </select>
          </Field>
        </>
      )}

      {/* Generic config for new node types — driven by SchemaForm */}
      {!['agent', 'gate', 'manual-trigger', 'webhook-trigger', 'cron-trigger'].includes(stage.type) && (
        <GenericNodeConfig
          stage={stage}
          onUpdate={(updated) => {
            if (readonly) return;
            onChange(updated);
          }}
          nodeType={stage.type}
          readonly={readonly}
        />
      )}
    </>
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
  stage,
  onUpdate,
  nodeType,
  readonly,
}: {
  stage: StageDefinition;
  onUpdate: (s: StageDefinition) => void;
  nodeType?: string;
  readonly?: boolean;
}) {
  const { data: specs } = useNodeTypes();
  const spec = specs?.find((s) => s.id === stage.type);

  const handleChange = useCallback(
    (config: Record<string, unknown>) => {
      if (readonly) return;
      onUpdate({ ...stage, config });
    },
    [stage, onUpdate, readonly],
  );

  if (!spec) {
    return <div className="text-xs text-text-tertiary py-2">Unknown node type: {stage.type}</div>;
  }

  return (
    <>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">{spec.name} Configuration</div>
      <SchemaForm
        schema={spec.configSchema}
        value={(stage.config || {}) as Record<string, unknown>}
        onChange={handleChange}
        nodeType={nodeType}
        returnSchema={(stage.config as Record<string, unknown>)?.output_schema as Record<string, unknown> | undefined}
        sandbox={(stage.config as Record<string, unknown>)?.sandbox as boolean | undefined}
        readonly={readonly}
      />
    </>
  );
}
