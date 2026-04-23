import { useCallback, useMemo } from 'react';
import { useNodeTypes } from '../../hooks/queries';
import { type StageDefinition, type WorkflowDefinition } from '../../lib/api';
import { SchemaForm } from './SchemaForm';
import { ConfigCardRenderer } from './ConfigCardRenderer';
import { resolveSpecOutputSchema } from '../../lib/resolveOutputSchema';

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
  const { data: nodeTypeSpecs } = useNodeTypes();
  const nodeTypeInfo = nodeTypeSpecs?.find((s) => s.id === stage.type);

  // Path-based update helper — used by configCards that render editable fields (e.g. cycle-behavior).
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

  const handleConfigChange = useCallback(
    (config: Record<string, unknown>) => {
      if (readonly) return;
      onChange({ ...stage, config });
    },
    [stage, onChange, readonly],
  );

  // For readOnly output_schema fields (e.g. gate, review-gate, prompt-trigger, cron-trigger),
  // the stored stage.config.output_schema can be stale if the spec evolved after stage creation.
  // Override the display value with the resolved schema from the spec (with x-passthrough substituted),
  // so the CodeWidget always shows a fresh, accurate shape.
  const configForDisplay = useMemo<Record<string, unknown>>(() => {
    const base = (stage.config || {}) as Record<string, unknown>;
    if (!nodeTypeInfo || !definition) return base;

    const configSchemaProps = (nodeTypeInfo.configSchema?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const outputSchemaProp = configSchemaProps['output_schema'];

    // Only override when the spec marks output_schema readOnly — user-editable schemas
    // (agent, code-executor, etc.) must continue to show the user's edited value.
    if (!outputSchemaProp || outputSchemaProp['readOnly'] !== true) return base;

    // Use the spec's current defaultConfig as the canonical base — ignoring any stale
    // stage.config.output_schema — then substitute x-passthrough fields with the live
    // upstream shape so users see the resolved typed schema.
    const specSchema = nodeTypeInfo.defaultConfig?.output_schema as Record<string, unknown> | undefined;
    if (specSchema === undefined) return base;

    const resolved = resolveSpecOutputSchema(specSchema, stage.id, definition, nodeTypeSpecs ?? undefined);
    return { ...base, output_schema: resolved };
  }, [stage, nodeTypeInfo, definition, nodeTypeSpecs]);

  if (!nodeTypeInfo) {
    return <div className="text-xs text-text-tertiary py-2">Unknown node type: {stage.type}</div>;
  }

  const apiOrigin = window.location.origin;
  const workflowId = definition?.id ?? '';

  return (
    <>
      {/* Declarative page-level cards (help text, copy-URL, curl snippets, etc.) */}
      {nodeTypeInfo.configCards?.map((card, i) => (
        <ConfigCardRenderer
          key={i}
          card={card}
          stage={stage}
          workflowId={workflowId}
          apiOrigin={apiOrigin}
          definition={definition}
          onConfigChange={definition ? update : undefined}
          readonly={readonly}
        />
      ))}

      {/* For trigger stages: show expected payload fields derived from downstream edges */}
      {expectedPayloadFields && <ExpectedInputsBlock fields={expectedPayloadFields} />}

      {/* Schema-driven form for all config fields */}
      <SchemaForm
        schema={nodeTypeInfo.configSchema ?? { type: 'object', properties: {} }}
        value={configForDisplay}
        onChange={handleConfigChange}
        nodeType={stage.type}
        returnSchema={configForDisplay?.output_schema as Record<string, unknown> | undefined}
        sandbox={(stage.config as Record<string, unknown>)?.sandbox as boolean | undefined}
        readonly={readonly}
      />
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
