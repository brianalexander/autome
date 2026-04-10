import { useState, useEffect } from 'react';
import { useAgents, useAgent } from '../../hooks/queries';
import {
  type StageDefinition,
  type KiroAgentSpec,
  type MCPServerConfig,
  type WorkflowDefinition,
} from '../../lib/api';
import { CodeEditor } from './CodeEditor';
import { ProviderSelect } from '../ui/ProviderSelect';
import { Field } from './ConfigPanelShared';

type AgentOverrides = {
  model?: string;
  additional_prompt?: string;
  additional_tools?: string[];
  additional_mcp_servers?: MCPServerConfig[];
  acpProvider?: string;
};

interface AgentConfigSectionProps {
  stage: StageDefinition;
  definition: WorkflowDefinition;
  /** Path-based update function from the parent ConfigPanel */
  update: (path: string, value: unknown) => void;
}

export function AgentConfigSection({ stage, definition, update }: AgentConfigSectionProps) {
  const cfg = (stage.config || {}) as {
    agentId?: string;
    max_iterations?: number;
    max_turns?: number;
    timeout_minutes?: number;
    output_schema?: unknown;
    overrides?: AgentOverrides;
    cycle_behavior?: string;
    [key: string]: unknown;
  };

  const { data: agentList } = useAgents();
  const { data: selectedAgent } = useAgent((cfg.agentId as string) || '');

  return (
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

      <Field label="Output Schema" required description="JSON Schema defining what this agent must output. Injected into the agent's prompt.">
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

      {/* Overrides section */}
      <OverridesSection
        overrides={cfg.overrides}
        canonicalSpec={selectedAgent?.spec}
        onChange={(overrides) => update('config.overrides', overrides)}
        onReset={() => update('config.overrides', undefined)}
      />
    </>
  );
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

interface OverridesSectionProps {
  overrides: AgentOverrides | undefined;
  canonicalSpec: KiroAgentSpec | undefined;
  onChange: (overrides: AgentOverrides) => void;
  onReset: () => void;
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

          <Field
            label="Additional MCP Servers"
            description="Keyed by server name. Each entry takes a command, args (array), and optional env (object)."
          >
            <McpServersEditor
              value={overrides?.additional_mcp_servers}
              onChange={(servers) => updateOverride('additional_mcp_servers', servers)}
            />
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

// ---------------------------------------------------------------------------
// MCP Servers JSON editor
// ---------------------------------------------------------------------------

const MCP_PLACEHOLDER = `{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "$GITHUB_TOKEN"
    }
  }
}`;

/**
 * Convert the array storage form (`[{ name, command, args, env }]`) into the
 * keyed object form (`{ name: { command, args, env } }`) shown in the editor.
 */
function serversToKeyed(servers: MCPServerConfig[] | undefined): string {
  if (!servers || servers.length === 0) return '';
  const obj: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const s of servers) {
    obj[s.name] = {
      command: s.command,
      args: s.args || [],
      ...(s.env ? { env: s.env } : {}),
    };
  }
  return JSON.stringify(obj, null, 2);
}

/**
 * Parse the keyed object form back into the array storage form.
 * Returns null if the JSON is invalid.
 */
function keyedToServers(json: string): MCPServerConfig[] | null {
  if (!json.trim()) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const servers: MCPServerConfig[] = [];
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof v.command !== 'string') continue;
      const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [];
      const env =
        v.env && typeof v.env === 'object' && !Array.isArray(v.env)
          ? (v.env as Record<string, string>)
          : undefined;
      servers.push({ name, command: v.command, args, ...(env ? { env } : {}) });
    }
    return servers;
  } catch {
    return null;
  }
}

function McpServersEditor({
  value,
  onChange,
}: {
  value: MCPServerConfig[] | undefined;
  onChange: (servers: MCPServerConfig[] | undefined) => void;
}) {
  // Local text state so users can type freely without losing intermediate invalid JSON.
  // Sync from `value` only when the parent prop changes (mounting / external updates).
  const initial = serversToKeyed(value);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  // Reset local text when the upstream value changes (e.g. switching stages).
  useEffect(() => {
    setText(serversToKeyed(value));
    setError(null);
    // We intentionally only watch the serialized form so editing in place doesn't loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serversToKeyed(value)]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      setError(null);
      onChange(undefined);
      return;
    }
    const servers = keyedToServers(raw);
    if (servers === null) {
      setError('Invalid JSON or wrong shape — expected `{ "name": { "command": "...", "args": [...], "env": { ... } } }`');
      return;
    }
    setError(null);
    onChange(servers.length > 0 ? servers : undefined);
  };

  return (
    <div className="space-y-1">
      <CodeEditor
        value={text}
        onChange={(val) => {
          setText(val);
          commit(val);
        }}
        editorMode="json"
        placeholder={MCP_PLACEHOLDER}
        minHeight="140px"
      />
      {error && <p className="text-[10px] text-red-500">{error}</p>}
    </div>
  );
}
