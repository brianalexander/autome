import { useState, useEffect } from 'react';
import { useAgent } from '../../../hooks/queries';
import type { WidgetProps } from './types';
import type { MCPServerConfig } from '../../../lib/api';
import { Field } from '../ConfigPanelShared';
import { CodeEditor } from '../CodeEditor';
import { ProviderSelect } from '../../ui/ProviderSelect';

type AgentOverrides = {
  model?: string;
  additional_prompt?: string;
  additional_tools?: string[];
  additional_mcp_servers?: MCPServerConfig[];
  acpProvider?: string;
};

/**
 * AgentOverridesWidget — collapsible accordion for per-stage agent overrides.
 *
 * Registered as 'agent-overrides'. Use in configSchema:
 *   { type: 'object', title: 'Overrides', 'x-widget': 'agent-overrides' }
 *
 * The widget reads `agentId` from its parent form's value to look up the canonical spec
 * for showing current defaults (model placeholder). It accesses agentId via a DOM-level
 * query-string approach — but since WidgetProps only give us the field value, we rely on
 * the parent to pass agentId via a custom schema extension if needed. For now, we look up
 * the spec based on the current overrides.model placeholder approach without the parent agentId.
 */
export function AgentOverridesWidget({ value, onChange, disabled }: WidgetProps<AgentOverrides | undefined>) {
  const overrides = value as AgentOverrides | undefined;
  const [open, setOpen] = useState(false);

  const updateOverride = <K extends keyof AgentOverrides>(key: K, val: AgentOverrides[K]) => {
    onChange({ ...(overrides || {}), [key]: val } as AgentOverrides);
  };

  const hasOverrides =
    overrides &&
    (overrides.model ||
      overrides.additional_prompt ||
      overrides.acpProvider ||
      (overrides.additional_tools && overrides.additional_tools.length > 0) ||
      (overrides.additional_mcp_servers && overrides.additional_mcp_servers.length > 0));

  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className={`w-full flex items-center justify-between p-3 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-secondary/30 transition-colors${disabledCls}`}
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
              disabled={disabled}
              className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono${disabledCls}`}
              placeholder="e.g., claude-opus-4-20250514"
            />
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
              disabled={disabled}
              className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary min-h-[60px] resize-y${disabledCls}`}
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
              disabled={disabled}
            />
          </Field>

          {hasOverrides && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              disabled={disabled}
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
  disabled,
}: {
  value: MCPServerConfig[] | undefined;
  onChange: (servers: MCPServerConfig[] | undefined) => void;
  disabled?: boolean;
}) {
  const initial = serversToKeyed(value);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(serversToKeyed(value));
    setError(null);
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
        readOnly={disabled}
      />
      {error && <p className="text-[10px] text-red-500">{error}</p>}
    </div>
  );
}
