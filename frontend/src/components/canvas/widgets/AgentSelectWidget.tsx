import { useState } from 'react';
import { useAgents, useAgent } from '../../../hooks/queries';
import type { WidgetProps } from './types';
import type { KiroAgentSpec } from '../../../lib/api';

/**
 * AgentSelectWidget — dropdown for selecting an agent by name, with an inline
 * read-only spec view for the currently selected agent.
 *
 * Registered as 'agent-select'. Use in configSchema:
 *   { type: 'string', title: 'Agent', 'x-widget': 'agent-select' }
 */
export function AgentSelectWidget({ value, onChange, disabled }: WidgetProps<string | undefined>) {
  const { data: agentList } = useAgents();
  const selectedName = typeof value === 'string' ? value : '';
  const { data: selectedAgent } = useAgent(selectedName);

  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';

  return (
    <div className="space-y-2">
      <select
        value={selectedName}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
        className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary${disabledCls}`}
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
        <p className="text-xs text-text-tertiary">
          No kiro agents found. Create one with <code className="font-mono">kiro-cli agent create</code>
        </p>
      )}

      {selectedAgent && <AgentSpecView spec={selectedAgent.spec} />}
    </div>
  );
}

/** Read-only view of the selected agent's canonical spec. */
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
            type="button"
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
