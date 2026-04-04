import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { useAgents, useAgent, useNodeTypes } from '../../hooks/queries';
import {
  isTriggerType,
  type StageDefinition,
  type KiroAgentSpec,
  type MCPServerConfig,
  type EdgeDefinition,
  type WorkflowDefinition,
} from '../../lib/api';
import { SchemaForm } from './SchemaForm';
import { CodeEditor } from './CodeEditor';
import { ProviderSelect } from '../ui/ProviderSelect';

interface ConfigPanelProps {
  stage: StageDefinition;
  definition: WorkflowDefinition;
  onSave: (updated: StageDefinition) => void;
  onDelete: () => void;
  onClose: () => void;
  onDefinitionChange?: (definition: WorkflowDefinition) => void;
}

export function ConfigPanel({ stage, definition, onSave, onDelete, onClose, onDefinitionChange }: ConfigPanelProps) {
  const { data: agentList } = useAgents();
  // Stage config is Record<string, unknown> at the type level, but we know the actual shape by node type
  const cfg = (stage.config || {}) as {
    // Agent config
    agentId?: string;
    max_iterations?: number;
    max_turns?: number;
    timeout_minutes?: number;
    output_schema?: unknown;
    overrides?: AgentOverrides;
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
    [key: string]: unknown;
  };
  const { data: selectedAgent } = useAgent((cfg.agentId as string) || '');

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const debouncedOnSave = useCallback((updated: StageDefinition) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => onSave(updated), 300);
  }, [onSave]);

  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  const update = useCallback((path: string, value: unknown) => {
    const next = structuredClone(stage);
    const parts = path.split('.');
    let obj: Record<string, unknown> = next as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] === undefined) obj[parts[i]] = {};
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    if (value === undefined) {
      delete obj[parts[parts.length - 1]];
    } else {
      obj[parts[parts.length - 1]] = value;
    }
    debouncedOnSave(next);
  }, [stage, debouncedOnSave]);

  // Compute upstream output schema(s) for autocomplete and reference
  const upstreamSchema = useMemo(() => {
    const incomingEdges = definition.edges.filter(e => e.target === stage.id);
    if (incomingEdges.length === 0) return undefined;
    if (incomingEdges.length === 1) {
      const sourceStage = definition.stages.find(s => s.id === incomingEdges[0].source);
      const sourceConfig = (sourceStage?.config || {}) as Record<string, unknown>;
      return sourceConfig.output_schema as Record<string, unknown> | undefined;
    }
    // Fan-in: merge upstream schemas into one object with source IDs as keys
    const merged: Record<string, unknown> = { type: 'object', properties: {} };
    const mergedProps = (merged as any).properties;
    for (const edge of incomingEdges) {
      const sourceStage = definition.stages.find(s => s.id === edge.source);
      const sourceConfig = (sourceStage?.config || {}) as Record<string, unknown>;
      const schema = sourceConfig.output_schema as Record<string, unknown> | undefined;
      if (schema) {
        mergedProps[edge.source] = schema;
      }
    }
    return Object.keys(mergedProps).length > 0 ? merged : undefined;
  }, [definition, stage.id]);

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
        <h3 className="font-semibold text-sm">Configure: {stage.id}</h3>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors p-1" title="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {/* Stage ID (read-only) */}
        <Field label="Stage ID">
          <input value={stage.id} disabled className="input-field opacity-60" />
        </Field>

        {/* Stage Type */}
        <Field label="Type">
          <span className="text-sm capitalize">{stage.type}</span>
        </Field>

        {/* Node Label */}
        <Field label="Label">
          <input
            value={stage.label || ''}
            onChange={(e) => update('label', e.target.value || undefined)}
            className="input-field"
            placeholder={stage.type
              .split('-')
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ')}
          />
        </Field>

        {/* Node Description */}
        <Field label="Description">
          <input
            value={stage.description || ''}
            onChange={(e) => update('description', e.target.value || undefined)}
            className="input-field"
            placeholder="Short description of what this node does"
          />
        </Field>

        {/* Upstream input schema reference */}
        {upstreamSchema?.properties != null && !isTriggerType(stage.type) && (
          <div className="bg-surface-secondary/50 border border-border-subtle rounded-lg p-3 mb-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">
              Input
            </div>
            <div className="space-y-1">
              {Object.entries(upstreamSchema.properties as Record<string, Record<string, unknown>>).map(([key, propSchema]) => {
                const propType = propSchema.type as string | undefined;
                const propDesc = propSchema.description as string | undefined;
                return (
                  <div key={key} className="flex items-baseline gap-2 text-xs">
                    <code className="text-blue-400 font-mono">input.{key}</code>
                    {propType && <span className="text-text-muted text-[10px]">{propType}</span>}
                    {propDesc && <span className="text-text-tertiary text-[10px]">— {propDesc}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Agent-specific config */}
        {stage.type === 'agent' && (
          <>
            {/* Agent Selector */}
            <Field label="Agent">
              <select
                value={cfg.agentId || ''}
                onChange={(e) => update('config.agentId', e.target.value)}
                className="input-field"
              >
                <option value="">Select an agent...</option>
                {agentList && agentList.length > 0
                  ? agentList.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name} ({a.source}){a.spec.description ? ` — ${a.spec.description}` : ''}
                      </option>
                    ))
                  : null}
              </select>
              {agentList && agentList.length === 0 && (
                <p className="text-xs text-text-tertiary mt-1">
                  No kiro agents found. Create one with <code className="font-mono">kiro-cli agent create</code>
                </p>
              )}
            </Field>

            {/* Agent Spec (read-only) */}
            {selectedAgent && <AgentSpecView spec={selectedAgent.spec} />}

            {/* Workflow-specific fields divider */}
            <div className="border-t border-border pt-4">
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
                Workflow Configuration
              </div>
            </div>

            <Field label="Max Iterations">
              <input
                type="number"
                value={cfg.max_iterations ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  update('config.max_iterations', isNaN(val) ? undefined : val);
                }}
                className="input-field w-24"
                min={1}
                placeholder="∞"
              />
            </Field>

            <Field label="Max Turns">
              <input
                type="number"
                value={cfg.max_turns ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  update('config.max_turns', isNaN(val) ? undefined : val);
                }}
                className="input-field w-24"
                min={1}
                placeholder="∞"
              />
            </Field>

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

            <Field label="Output Schema" description="JSON Schema defining what this agent must output. Injected into the agent's prompt.">
              <CodeEditor
                value={typeof cfg.output_schema === 'string' ? cfg.output_schema : (cfg.output_schema ? JSON.stringify(cfg.output_schema, null, 2) : '')}
                onChange={(val) => {
                  try {
                    const parsed = JSON.parse(val);
                    update('config.output_schema', parsed);
                  } catch {
                    // Store raw string while user is typing (invalid JSON mid-edit)
                    update('config.output_schema', val || undefined);
                  }
                }}
                editorMode="json"
                placeholder={'{\n  "type": "object",\n  "properties": {\n    "decision": {\n      "type": "string",\n      "enum": ["approved", "rejected"],\n      "description": "The review verdict"\n    },\n    "reason": {\n      "type": "string",\n      "description": "Explanation of the decision"\n    }\n  },\n  "required": ["decision", "reason"]\n}'}
                minHeight="120px"
              />
            </Field>

            {/* Cycle Behavior — shown for all agent nodes; only meaningful when node is a cycle target */}
            {canStageCycle(stage.id, definition) && (
              <div className="border-t border-border pt-4">
                <div className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <span className="text-rose-400">↻</span> Cycle Behavior
                </div>
                <Field label="Session Mode" description="How this agent's session is handled when re-entered via a cycle edge">
                  <select
                    value={(cfg.cycle_behavior as string) || 'fresh'}
                    onChange={(e) => update('config.cycle_behavior', e.target.value)}
                    className="input-field"
                  >
                    <option value="fresh">Fresh — new session each cycle</option>
                    <option value="continue">Continue — resume prior session</option>
                  </select>
                </Field>
              </div>
            )}

            <Field label="ACP Provider (workflow default)">
              <ProviderSelect
                value={definition.acpProvider}
                onChange={(val) => onDefinitionChange?.({ ...definition, acpProvider: val })}
                emptyLabel="System default"
              />
              <p className="text-[10px] text-text-tertiary mt-0.5">
                Applies to all stages. Use the stage override below to change it per stage.
              </p>
            </Field>

            {/* Overrides section */}
            <OverridesSection
              overrides={cfg.overrides}
              canonicalSpec={selectedAgent?.spec}
              onChange={(overrides) => update('config.overrides', overrides)}
              onReset={() => update('config.overrides', undefined)}
            />
          </>
        )}

        {/* === Manual Trigger config === */}
        {stage.type === 'manual-trigger' && (
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
        {stage.type === 'webhook-trigger' && (
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
        {stage.type === 'cron-trigger' && (
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
        {stage.type === 'gate' && (
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
        {!['agent', 'gate', 'manual-trigger', 'webhook-trigger', 'cron-trigger'].includes(stage.type) && (
          <GenericNodeConfig editState={stage} onUpdate={(updated) => debouncedOnSave(updated)} upstreamSchema={upstreamSchema} nodeType={stage.type} />
        )}

        {/* --- Advanced: Fan-in, Retry, Map (all step types) --- */}
        {!isTriggerType(stage.type) && (
          <AdvancedStageConfig editState={stage} definition={definition} onUpdate={update} />
        )}
      </div>
    </div>
  );
}

function findUpstreamStages(stageId: string, definition: WorkflowDefinition): StageDefinition[] {
  // Only return direct upstream stages (one edge hop), not transitive ancestors.
  // Transitive ancestors are accessible via context.stages["id"].latest
  const directSourceIds = definition.edges
    .filter(e => e.target === stageId)
    .map(e => e.source);
  return definition.stages.filter(s => directSourceIds.includes(s.id));
}

function canStageCycle(stageId: string, definition: WorkflowDefinition): boolean {
  const reachable = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of definition.edges) {
      if (edge.source === current && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return definition.edges.some((e) => e.target === stageId && reachable.has(e.source));
}

function ContextTemplateHelp({ stageId, definition }: { stageId: string; definition: WorkflowDefinition }) {
  const upstreamStages = findUpstreamStages(stageId, definition);
  const canCycle = canStageCycle(stageId, definition);

  return (
    <div className="bg-surface-secondary/50 border border-border rounded-lg p-3 space-y-2">
      <div className="text-xs font-medium text-text-secondary uppercase tracking-wider">Available Variables</div>

      {/* Trigger data */}
      <div className="space-y-1">
        <div className="text-[11px] text-text-primary font-medium">Trigger</div>
        <code className="block text-[10px] text-blue-600 dark:text-blue-300 bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
          {'{{ trigger.payload }}'}
        </code>
        <code className="block text-[10px] text-blue-600 dark:text-blue-300 bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
          {'{{ trigger.payload.prompt }}'}
        </code>
      </div>

      {/* Upstream stages */}
      {upstreamStages.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] text-text-primary font-medium">Upstream Stages</div>
          {upstreamStages.map((stage) => (
            <div key={stage.id} className="space-y-0.5">
              <div className="text-[10px] text-text-secondary">
                {stage.id} ({stage.type})
              </div>
              <code className="block text-[10px] text-green-600 dark:text-green-300 bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
                {`{{ stages.${stage.id}.latest }}`}
              </code>
              <code className="block text-[10px] text-text-secondary bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
                {`{{ stages.${stage.id}.run_count }}`}
              </code>
            </div>
          ))}
        </div>
      )}

      {/* Self-reference (if stage can cycle) */}
      {canCycle && (
        <div className="space-y-1">
          <div className="text-[11px] text-rose-600 dark:text-rose-300 font-medium">Cycle (own prior output)</div>
          <code className="block text-[10px] text-rose-600 dark:text-rose-300 bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
            {`{{ stages.${stageId}.latest }}`}
          </code>
          <code className="block text-[10px] text-rose-600 dark:text-rose-300 bg-surface-secondary px-2 py-1 rounded font-mono cursor-pointer select-all">
            {`{{ stages.${stageId}.run_count + 1 }}`}
          </code>
        </div>
      )}

      {/* Conditional syntax hint */}
      <div className="space-y-1">
        <div className="text-[11px] text-text-primary font-medium">Conditionals</div>
        <code className="block text-[10px] text-purple-600 dark:text-purple-300 bg-surface-secondary px-2 py-1 rounded font-mono">
          {`{% if stages.${upstreamStages[0]?.id || 'stage-id'}.latest %}...{% endif %}`}
        </code>
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

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      {children}
      {description && <p className="text-[10px] text-text-tertiary mt-1">{description}</p>}
    </div>
  );
}

// Read-only view of the agent's canonical spec
function AgentSpecView({ spec }: { spec: KiroAgentSpec }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-surface-secondary/50 border border-border rounded-lg p-3 space-y-2">
      <div className="text-xs font-medium text-text-secondary uppercase tracking-wider">Agent Spec</div>

      {spec.description && <div className="text-xs text-text-secondary">{spec.description}</div>}

      {spec.model && (
        <div className="flex justify-between text-xs">
          <span className="text-text-tertiary">Model</span>
          <span className="text-text-primary font-mono">{spec.model}</span>
        </div>
      )}

      {spec.tools && Array.isArray(spec.tools) && spec.tools.length > 0 && (
        <div>
          <span className="text-xs text-text-tertiary">Tools</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {spec.tools.map((t) => (
              <span
                key={t}
                className="text-[10px] bg-surface-tertiary text-text-primary px-1.5 py-0.5 rounded font-mono"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {spec.mcpServers && Object.keys(spec.mcpServers).length > 0 && (
        <div>
          <span className="text-xs text-text-tertiary">MCP Servers</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {Object.keys(spec.mcpServers).map((name) => (
              <span
                key={name}
                className="text-[10px] bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {spec.prompt && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            {expanded ? '▼' : '▶'} System Prompt
          </button>
          {expanded && (
            <pre className="mt-1 text-xs text-text-secondary bg-surface-secondary rounded p-2 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {spec.prompt}
            </pre>
          )}
        </div>
      )}

      {spec.resources && spec.resources.length > 0 && (
        <div>
          <span className="text-xs text-text-tertiary">Resources</span>
          <div className="mt-1 space-y-0.5">
            {spec.resources.map((r) => (
              <div key={r} className="text-[10px] text-text-secondary font-mono truncate">
                {r}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type AgentOverrides = {
  model?: string;
  additional_prompt?: string;
  additional_tools?: string[];
  additional_mcp_servers?: MCPServerConfig[];
  acpProvider?: string;
};

interface OverridesSectionProps {
  overrides: AgentOverrides | undefined;
  canonicalSpec: KiroAgentSpec | undefined;
  onChange: (overrides: AgentOverrides) => void;
  onReset: () => void;
}

// --- Edge config helpers ---

/** Extract field references from a JS expression like output.foo.bar */
function extractFieldReferences(expr: string): string[][] {
  const paths: string[][] = [];
  const regex = /output\.(\w+(?:\.\w+)*)/g;
  let match;
  while ((match = regex.exec(expr)) !== null) {
    paths.push(match[1].split('.'));
  }
  return paths;
}

/** Check if a field path exists in a JSON Schema */
function validateFieldPath(schema: Record<string, unknown>, path: string[]): boolean {
  let current = schema;
  for (const key of path) {
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !props[key]) return false;
    current = props[key];
  }
  return true;
}

interface EdgeConfigPanelProps {
  edge: EdgeDefinition;
  definition: WorkflowDefinition;
  isCycleEdge?: boolean;
  onSave: (updated: EdgeDefinition) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function EdgeConfigPanel({ edge, definition, isCycleEdge, onSave, onDelete, onClose }: EdgeConfigPanelProps) {
  const { data: specs } = useNodeTypes();

  const edgeSaveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const debouncedOnSave = useCallback((updated: EdgeDefinition) => {
    if (edgeSaveTimeoutRef.current) clearTimeout(edgeSaveTimeoutRef.current);
    edgeSaveTimeoutRef.current = setTimeout(() => onSave(updated), 300);
  }, [onSave]);

  useEffect(() => () => {
    if (edgeSaveTimeoutRef.current) clearTimeout(edgeSaveTimeoutRef.current);
  }, []);

  // Look up source/target node type specs for edge schema
  const sourceStage = definition.stages.find((s) => s.id === edge.source);
  const targetStage = definition.stages.find((s) => s.id === edge.target);
  const sourceSpec = specs?.find((s) => s.id === sourceStage?.type);
  const targetSpec = specs?.find((s) => s.id === targetStage?.type);

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between flex-shrink-0">
        <h3 className="font-semibold text-sm">Configure Edge</h3>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors p-1" title="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        <Field label="Edge ID">
          <input value={edge.id} disabled className="input-field opacity-60" />
        </Field>

        <Field label="Connection">
          <div className="text-sm text-text-primary font-mono">
            {edge.source} → {edge.target}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {sourceSpec?.name || sourceStage?.type} → {targetSpec?.name || targetStage?.type}
          </div>
        </Field>

        {/* Source output schema reference — shows what fields are available */}
        {(() => {
          const sourceConfig = (sourceStage?.config || {}) as Record<string, unknown>;
          const outputSchema = sourceConfig.output_schema as Record<string, unknown> | undefined;
          if (!outputSchema?.properties) return null;
          const props = outputSchema.properties as Record<string, { type?: string; description?: string }>;
          return (
            <div className="bg-surface-secondary/50 border border-border-subtle rounded-lg p-3">
              <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">
                Available from {sourceStage?.label || edge.source}
              </div>
              <div className="space-y-1">
                {Object.entries(props).map(([key, ps]) => {
                  const t = (ps as Record<string, unknown>).type as string | undefined;
                  const d = (ps as Record<string, unknown>).description as string | undefined;
                  return (
                    <div key={key} className="flex items-baseline gap-2 text-xs">
                      <code className="text-blue-400 font-mono">output.{key}</code>
                      {t && <span className="text-text-muted text-[10px]">{t}</span>}
                      {d && <span className="text-text-tertiary text-[10px]">— {d}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <Field label="Label">
          <input
            value={edge.label || ''}
            onChange={(e) => debouncedOnSave({ ...edge, label: e.target.value || undefined })}
            className="input-field"
            placeholder="e.g., Approved, Needs revision"
          />
        </Field>

        <Field label="Trigger">
          <select
            value={edge.trigger || 'on_success'}
            onChange={(e) =>
              debouncedOnSave({
                ...edge,
                trigger: e.target.value === 'on_success' ? undefined : (e.target.value as 'on_error'),
              })
            }
            className="input-field"
          >
            <option value="on_success">On Success (default)</option>
            <option value="on_error">On Error (fallback path)</option>
          </select>
          {edge.trigger === 'on_error' && (
            <div className="text-[10px] text-orange-600 dark:text-orange-400 mt-0.5">
              This edge fires when the source stage fails after exhausting retries. The target receives{' '}
              {'{ error, stageId, lastOutput }'} as input.
            </div>
          )}
        </Field>

        {/* Source node's outEdgeSchema */}
        {sourceSpec?.outEdgeSchema && (
          <div className="border-t border-border pt-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">From: {sourceSpec.name}</div>
            <SchemaForm
              schema={sourceSpec.outEdgeSchema}
              value={edge as Record<string, unknown>}
              onChange={(updated) => debouncedOnSave({ ...edge, ...updated })}
            />
          </div>
        )}

        {/* Target node's inEdgeSchema */}
        {targetSpec?.inEdgeSchema && (
          <div className="border-t border-border pt-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">To: {targetSpec.name}</div>
            <SchemaForm
              schema={targetSpec.inEdgeSchema}
              value={edge as Record<string, unknown>}
              onChange={(updated) => debouncedOnSave({ ...edge, ...updated })}
            />
          </div>
        )}

        {/* Fallback: if neither node declares edge schemas, show basic fields */}
        {(() => {
          const sourceConfig = (sourceStage?.config || {}) as Record<string, unknown>;
          const sourceOutputSchema = sourceConfig.output_schema as Record<string, unknown> | undefined;
          return (
            <>
              {!sourceSpec?.outEdgeSchema && !targetSpec?.inEdgeSchema && (
                <Field label="Condition (JS expression)">
                  <CodeEditor
                    value={edge.condition || ''}
                    onChange={(val) => debouncedOnSave({ ...edge, condition: val || undefined })}
                    editorMode="condition"
                    minHeight="60px"
                    outputSchema={sourceOutputSchema}
                  />
                </Field>
              )}

              {/* Design-time validation warnings */}
              {(() => {
                const outputSchema = sourceOutputSchema;
                const conditionExpr = edge.condition;
                if (!outputSchema?.properties || !conditionExpr) return null;

                const refs = extractFieldReferences(conditionExpr);
                const invalid = refs.filter((path) => !validateFieldPath(outputSchema, path));
                if (invalid.length === 0) return null;

                return (
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-700/50 rounded-lg p-2.5 text-xs">
                    <div className="text-amber-700 dark:text-amber-300 font-medium mb-1">Schema warning</div>
                    {invalid.map((path, i) => (
                      <div key={i} className="text-amber-600 dark:text-amber-400">
                        <code className="font-mono">output.{path.join('.')}</code> not found in source schema
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          );
        })()}
      </div>
    </div>
  );
}

function OverridesSection({ overrides, canonicalSpec, onChange, onReset }: OverridesSectionProps) {
  const [open, setOpen] = useState(false);

  const updateOverride = <K extends keyof NonNullable<AgentOverrides>>(key: K, value: NonNullable<AgentOverrides>[K]) => {
    onChange({ ...(overrides || {}), [key]: value });
  };

  const hasOverrides =
    overrides &&
    (overrides.model ||
      overrides.additional_prompt ||
      overrides.acpProvider ||
      (overrides.additional_tools && overrides.additional_tools.length > 0) ||
      (overrides.additional_mcp_servers && overrides.additional_mcp_servers.length > 0));

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-secondary/30 transition-colors"
      >
        <span className="font-medium uppercase tracking-wider">
          Overrides
          {hasOverrides && <span className="ml-2 text-yellow-400 normal-case font-normal">(active)</span>}
        </span>
        <span>{open ? '▼' : '▶'}</span>
      </button>

      {open && (
        <div className="p-3 border-t border-border space-y-3">
          <p className="text-[10px] text-text-tertiary">
            These fields override the agent spec for this workflow stage only.
          </p>

          <Field label="Model Override">
            <input
              value={overrides?.model || ''}
              onChange={(e) => updateOverride('model', e.target.value || undefined)}
              className="input-field font-mono text-xs"
              placeholder={canonicalSpec?.model || 'e.g., claude-opus-4-20250514'}
            />
            {canonicalSpec?.model && (
              <p className="text-[10px] text-text-tertiary mt-0.5">
                Agent default: <span className="font-mono">{canonicalSpec.model}</span>
              </p>
            )}
          </Field>

          <Field label="ACP Provider">
            <ProviderSelect
              value={overrides?.acpProvider}
              onChange={(val) => updateOverride('acpProvider', val)}
              emptyLabel="Use workflow default"
            />
            <p className="text-[10px] text-text-tertiary mt-0.5">
              Overrides the workflow-level ACP provider for this stage only.
            </p>
          </Field>

          <Field label="Additional Prompt">
            <textarea
              value={overrides?.additional_prompt || ''}
              onChange={(e) => updateOverride('additional_prompt', e.target.value || undefined)}
              className="input-field min-h-[60px] resize-y text-xs"
              placeholder="Appended to the agent's system prompt"
            />
          </Field>

          <Field label="Additional MCP Servers">
            <div className="space-y-2">
              {(overrides?.additional_mcp_servers || []).map((server: MCPServerConfig, i: number) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-surface-secondary rounded p-2">
                  <span className="font-mono flex-1">{server.name}</span>
                  <button
                    onClick={() => {
                      const servers = [...(overrides?.additional_mcp_servers || [])];
                      servers.splice(i, 1);
                      updateOverride('additional_mcp_servers', servers.length ? servers : undefined);
                    }}
                    className="text-red-600 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const name = prompt('MCP server name:');
                  const command = prompt('Command (e.g., npx):');
                  const argsStr = prompt('Args (comma-separated):');
                  if (name && command) {
                    const servers: MCPServerConfig[] = [...(overrides?.additional_mcp_servers || [])];
                    servers.push({
                      name,
                      command,
                      args: argsStr?.split(',').map((s) => s.trim()) || [],
                    });
                    updateOverride('additional_mcp_servers', servers);
                  }
                }}
                className="text-xs text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
              >
                + Add MCP Server
              </button>
            </div>
          </Field>

          {hasOverrides && (
            <button
              onClick={onReset}
              className="w-full text-xs text-red-600 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 py-1.5 border border-red-900/50 rounded hover:border-red-800 transition-colors"
            >
              Reset Overrides
            </button>
          )}
        </div>
      )}
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
      />
    </>
  );
}

/** Advanced config section: fan-in trigger rule, retry, dynamic map. Shown for all step node types. */
function AdvancedStageConfig({
  editState,
  definition,
  onUpdate,
}: {
  editState: StageDefinition;
  definition: WorkflowDefinition;
  onUpdate: (path: string, value: unknown) => void;
}) {
  // Only show fan-in trigger rule if the stage has multiple incoming edges
  const incomingEdgeCount = definition.edges.filter((e) => e.target === editState.id).length;

  return (
    <div className="space-y-3 pt-3 border-t border-border/50">
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Advanced</div>

      {/* Fan-in trigger rule — only show when multiple incoming edges */}
      {incomingEdgeCount > 1 && (
        <Field label="Join Rule">
          <select
            value={editState.trigger_rule || 'all_success'}
            onChange={(e) => onUpdate('trigger_rule', e.target.value === 'all_success' ? undefined : e.target.value)}
            className="input-field text-xs"
          >
            <option value="all_success">Wait for all (all must succeed)</option>
            <option value="any_success">Any (fire on first success)</option>
            <option value="none_failed_min_one_success">Flexible (at least one success, none failed)</option>
          </select>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {editState.trigger_rule === 'any_success'
              ? 'Fires as soon as any upstream stage completes successfully.'
              : editState.trigger_rule === 'none_failed_min_one_success'
                ? 'Fires when all upstreams finish, if at least one succeeded and none failed. Skipped branches are OK.'
                : 'Waits for every upstream stage to succeed before firing.'}
          </div>
        </Field>
      )}

      {/* Retry */}
      <Field label="Retry on Failure">
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={editState.retry?.max_attempts ?? ''}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (isNaN(val) || val <= 1) {
                onUpdate('retry', undefined);
              } else {
                onUpdate('retry', { ...editState.retry, max_attempts: val });
              }
            }}
            className="input-field w-16"
            min={1}
            max={10}
            placeholder="1"
          />
          <span className="text-xs text-text-secondary">attempts</span>
        </div>
        {editState.retry && editState.retry.max_attempts > 1 && (
          <div className="flex gap-2 mt-1.5">
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-text-secondary">Delay</label>
              <input
                type="number"
                value={editState.retry.delay_ms ?? 1000}
                onChange={(e) => onUpdate('retry', { ...editState.retry, delay_ms: parseInt(e.target.value) || 1000 })}
                className="input-field w-20"
                min={0}
                step={500}
              />
              <span className="text-[10px] text-text-tertiary">ms</span>
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[10px] text-text-secondary">Backoff</label>
              <input
                type="number"
                value={editState.retry.backoff_multiplier ?? 2}
                onChange={(e) =>
                  onUpdate('retry', { ...editState.retry, backoff_multiplier: parseFloat(e.target.value) || 2 })
                }
                className="input-field w-14"
                min={1}
                step={0.5}
              />
              <span className="text-[10px] text-text-tertiary">x</span>
            </div>
          </div>
        )}
      </Field>

      {/* Dynamic Map */}
      <Field label="Map Over (Fan-out)">
        <input
          type="text"
          value={editState.map_over ?? ''}
          onChange={(e) => onUpdate('map_over', e.target.value || undefined)}
          className="input-field text-xs font-mono"
          placeholder="{{ stages.splitter.output.items }}"
        />
        <div className="text-[10px] text-text-tertiary mt-0.5">
          Template expression resolving to an array. Stage runs once per element.
        </div>
      </Field>

      {editState.map_over && (
        <>
          <Field label="Concurrency Limit">
            <input
              type="number"
              value={editState.concurrency ?? ''}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onUpdate('concurrency', isNaN(val) ? undefined : val);
              }}
              className="input-field w-20"
              min={1}
              placeholder="∞"
            />
          </Field>
          <Field label="Failure Tolerance">
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={editState.failure_tolerance ?? 0}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  onUpdate('failure_tolerance', isNaN(val) ? 0 : val);
                }}
                className="input-field w-16"
                min={0}
              />
              <span className="text-xs text-text-secondary">allowed failures</span>
            </div>
          </Field>
        </>
      )}
    </div>
  );
}
