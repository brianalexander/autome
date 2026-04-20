/**
 * AgentSessionViewer — Wrapper around AcpChatPane for viewing agent stage sessions.
 * Adds: header with status/tabs, iteration picker, config tab, prompt tab, stage output display.
 * Loads persisted transcript segments so chat history survives navigation.
 */
import { useState, useCallback, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { useCancelStage, useAgent, useInjectMessage, useStagePrompt, useRestartStageSession } from '../../hooks/queries';
import { useChatSegments } from '../../hooks/useChatSegments';
import { AcpChatPane } from '../chat/AcpChatPane';
import { formatDuration, formatElapsed } from '../../lib/format';
import { formatValue } from '../../lib/formatValue';
import { StatusBadge } from '../ui/StatusBadge';
import { SectionHeader } from '../ui/SectionHeader';
import { instances } from '../../lib/api';
import type { StageContext, StageRun, StageDefinition, KiroAgentSpec } from '../../lib/api';

interface AgentSessionViewerProps {
  instanceId: string;
  stageId: string;
  stageContext: StageContext;
  stageDef?: StageDefinition;
  onClose: () => void;
}

/** Convert tools/allowedTools field to an array regardless of whether it's a string or array. */
function toToolsList(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

export function AgentSessionViewer({ instanceId, stageId, stageContext, stageDef, onClose }: AgentSessionViewerProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'prompt' | 'config' | 'input' | 'output'>('chat');
  const [selectedRunIndex, setSelectedRunIndex] = useState<number>(stageContext.runs.length - 1);
  const [copied, setCopied] = useState(false);
  const cancelStage = useCancelStage();
  const injectMessage = useInjectMessage();
  const restartStageSession = useRestartStageSession();
  const stageCfg = (stageDef?.config || {}) as Record<string, any>;
  const agentId = stageCfg.agentId || '';
  const { data: agentInfo } = useAgent(agentId);

  const isRunning = stageContext.status === 'running';
  const runs = stageContext.runs;
  const hasMultipleRuns = runs.length > 1;
  const runIdx = Math.min(Math.max(selectedRunIndex, 0), runs.length - 1);
  const selectedRun: StageRun | undefined = runs.length > 0 ? runs[runIdx] : undefined;

  // Load persisted segments for this stage
  const { initialMessages } = useChatSegments(
    ['segments', instanceId, stageId],
    () => instances.getSegments(instanceId, stageId),
    { enabled: !!instanceId && !!stageId },
  );

  // Load rendered prompt
  const { data: promptData } = useStagePrompt(instanceId, stageId);

  // Elapsed timer for running stages
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !selectedRun?.started_at) return;
    const startMs = new Date(selectedRun.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, (Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, selectedRun?.started_at]);

  const handleSendMessage = useCallback(
    (message: string) => {
      injectMessage.mutate({ instanceId, stageId, message });
    },
    [instanceId, stageId, injectMessage],
  );

  const handleStop = useCallback(() => {
    cancelStage.mutate({ instanceId, stageId });
  }, [instanceId, stageId, cancelStage]);

  const handleRestartSession = useCallback(async () => {
    await restartStageSession.mutateAsync({ instanceId, stageId });
  }, [instanceId, stageId, restartStageSession]);

  const handleCopyConfig = useCallback(() => {
    const data = { stageDef, agentSpec: agentInfo?.spec };
    navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      console.error('Failed to copy config:', err);
    });
  }, [stageDef, agentInfo]);

  const duration =
    selectedRun?.started_at && selectedRun?.completed_at
      ? formatDuration(selectedRun.started_at, selectedRun.completed_at)
      : isRunning && elapsed > 0
        ? formatElapsed(elapsed)
        : null;

  // Cast to KiroAgentSpec to access Kiro-specific fields (mcpServers, resources, allowedTools).
  // The spec is typed as CanonicalAgentSpec (passthrough), but at runtime it contains all Kiro fields.
  const kiroSpec = agentInfo?.spec as KiroAgentSpec | undefined;
  const toolsList = toToolsList(agentInfo?.spec?.tools);
  const allowedToolsList = toToolsList(kiroSpec?.allowedTools);

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="border-b border-border flex-shrink-0">
        <div className="p-4 pb-0">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-mono text-sm font-bold">{stageId}</h3>
                <StatusBadge status={stageContext.status} />
                {duration && (
                  <span
                    className={`text-[10px] font-mono tabular-nums ${isRunning ? 'text-blue-400' : 'text-text-tertiary'}`}
                  >
                    {duration}
                  </span>
                )}
              </div>
              {hasMultipleRuns && (
                <select
                  value={runIdx}
                  onChange={(e) => setSelectedRunIndex(Number(e.target.value))}
                  className="text-[10px] bg-surface-secondary border border-border rounded px-1.5 py-0.5 text-text-primary cursor-pointer mt-1"
                >
                  {runs.map((run, i) => (
                    <option key={i} value={i}>
                      Run {i + 1}/{runs.length} — {run.status}
                    </option>
                  ))}
                </select>
              )}
              {/* Error indicator */}
              {selectedRun?.error && (
                <div className="text-[10px] text-red-400 mt-1 truncate max-w-64" title={selectedRun.error}>
                  Error: {selectedRun.error.slice(0, 80)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isRunning && (
                <button
                  onClick={() => {
                    if (!window.confirm('Restart the agent session? The current session will be terminated.')) return;
                    restartStageSession.mutate({ instanceId, stageId });
                  }}
                  disabled={restartStageSession.isPending}
                  className="px-2 py-0.5 text-[10px] rounded border border-amber-400/60 dark:border-amber-600/60 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-50"
                >
                  {restartStageSession.isPending ? 'Restarting...' : 'Restart Session'}
                </button>
              )}
              <button
                onClick={handleCopyConfig}
                className="text-text-tertiary hover:text-text-primary transition-colors p-1"
                title="Copy config as JSON"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              <button onClick={onClose} className="text-text-tertiary hover:text-text-primary text-xs">
                {'\u2715'}
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex mt-3 px-4">
          {(['chat', 'prompt', 'config'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-xs capitalize border-b-2 ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tab}
            </button>
          ))}
          {selectedRun?.input != null && (
            <button
              onClick={() => setActiveTab('input')}
              className={`px-3 py-1.5 text-xs capitalize border-b-2 ${
                activeTab === 'input'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Input
            </button>
          )}
          {selectedRun?.output != null && (
            <button
              onClick={() => setActiveTab('output')}
              className={`px-3 py-1.5 text-xs capitalize border-b-2 ${
                activeTab === 'output'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Output
            </button>
          )}
        </div>
      </div>

      {/* Chat tab — always mounted to keep WS subscriptions alive during tab switches */}
      <div
        data-testid="acp-chat-pane-wrapper"
        className={activeTab === 'chat' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}
      >
        <AcpChatPane
          eventPrefix="agent"
          eventFilter={{ instanceId, stageId }}
          placeholder="Send a message to the agent..."
          emptyMessage={isRunning ? 'Waiting for agent output...' : 'No transcript data available.'}
          isActive={isRunning}
          sessionState={isRunning ? 'idle' : undefined}
          onSendMessage={handleSendMessage}
          onStop={handleStop}
          onRestartSession={handleRestartSession}
          agentName={agentId || undefined}
          modelName={agentInfo?.spec?.model || undefined}
          initialMessages={initialMessages}
        />
      </div>

      {/* Prompt tab — always mounted */}
      <div className={activeTab === 'prompt' ? 'flex-1 overflow-y-auto p-4 min-h-0' : 'hidden'}>
        {promptData?.prompt ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <SectionHeader>Rendered Prompt</SectionHeader>
              <span className="text-[10px] text-text-muted">
                {promptData.created_at ? new Date(promptData.created_at).toLocaleTimeString() : ''}
              </span>
            </div>
            <pre className="text-xs text-text-secondary bg-surface-secondary rounded-lg p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
              {promptData.prompt}
            </pre>
          </div>
        ) : (
          <div className="text-text-tertiary text-sm text-center py-8">
            {stageContext.status === 'pending'
              ? 'Stage has not started yet.'
              : 'No rendered prompt available for this stage.'}
          </div>
        )}
      </div>

      {/* Config tab — always mounted */}
      <div className={activeTab === 'config' ? 'flex-1 overflow-y-auto min-h-0' : 'hidden'}>
        {stageDef ? (
          <div className="p-4 space-y-4">
            <SectionHeader>Agent</SectionHeader>
            <div className="space-y-3 pl-2 border-l-2 border-border">
              <ConfigField label="ID" value={<span className="font-mono">{agentId}</span>} />
              {agentInfo?.spec?.description && <ConfigField label="Description" value={agentInfo.spec.description} />}
              <ConfigField
                label="Model"
                value={
                  <span className="font-mono text-blue-400">
                    {agentInfo?.spec?.model || stageCfg.overrides?.model || 'default'}
                  </span>
                }
              />
              <ConfigField
                label="Source"
                value={
                  agentInfo ? (
                    <span className="text-xs">
                      {agentInfo.source} — <span className="font-mono text-text-tertiary">{agentInfo.path}</span>
                    </span>
                  ) : (
                    '-'
                  )
                }
              />
            </div>

            {agentInfo?.spec?.prompt && (
              <>
                <SectionHeader>System Prompt</SectionHeader>
                <pre className="text-xs text-text-secondary bg-surface-secondary rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {agentInfo.spec.prompt}
                </pre>
              </>
            )}

            {toolsList.length > 0 && (
              <>
                <SectionHeader>Tools</SectionHeader>
                <div className="flex flex-wrap gap-1.5">
                  {toolsList.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] font-mono bg-surface-tertiary text-text-primary px-2 py-0.5 rounded"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}

            {allowedToolsList.length > 0 && (
              <>
                <SectionHeader>Allowed Tools</SectionHeader>
                <div className="flex flex-wrap gap-1.5">
                  {allowedToolsList.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] font-mono bg-surface-tertiary text-green-600 dark:text-green-400 px-2 py-0.5 rounded"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}

            {kiroSpec?.mcpServers && Object.keys(kiroSpec.mcpServers).length > 0 && (
              <>
                <SectionHeader>MCP Servers</SectionHeader>
                <div className="space-y-2">
                  {Object.entries(kiroSpec.mcpServers).map(([name, config]) => (
                    <div key={name} className="bg-surface-secondary rounded p-2.5 space-y-1">
                      <div className="text-xs text-text-primary font-mono font-medium">{name}</div>
                      <div className="text-[10px] text-text-tertiary font-mono">
                        {config.command} {config.args?.join(' ')}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {kiroSpec?.resources && kiroSpec.resources.length > 0 && (
              <>
                <SectionHeader>Resources</SectionHeader>
                <div className="space-y-1">
                  {kiroSpec.resources.map((r) => (
                    <div key={r} className="text-xs font-mono text-text-secondary">
                      {r}
                    </div>
                  ))}
                </div>
              </>
            )}

            <SectionHeader className="pt-2 border-t border-border">Workflow Stage Config</SectionHeader>
            <div className="space-y-3 pl-2 border-l-2 border-border">
              <div className="flex gap-4">
                {stageCfg.max_iterations && <ConfigField label="Max Iterations" value={stageCfg.max_iterations} />}
                {stageCfg.max_turns && <ConfigField label="Max Turns" value={stageCfg.max_turns} />}
                {stageCfg.timeout_minutes && <ConfigField label="Timeout" value={`${stageCfg.timeout_minutes} min`} />}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm p-4">
            Stage definition not available.
          </div>
        )}
      </div>

      {/* Input tab — always mounted */}
      <div className={activeTab === 'input' ? 'flex-1 overflow-y-auto p-4 min-h-0' : 'hidden'}>
        {selectedRun?.input != null ? (
          <pre className="text-xs text-text-secondary bg-surface-secondary rounded-lg p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
            {formatValue(selectedRun.input)}
          </pre>
        ) : (
          <div className="text-text-tertiary text-sm text-center py-8">No input available for this run.</div>
        )}
      </div>

      {/* Output tab — always mounted */}
      <div className={activeTab === 'output' ? 'flex-1 overflow-y-auto p-4 min-h-0' : 'hidden'}>
        {selectedRun?.output != null ? (
          <pre className="text-xs text-text-secondary bg-surface-secondary rounded-lg p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
            {formatValue(selectedRun.output)}
          </pre>
        ) : (
          <div className="text-text-tertiary text-sm text-center py-8">No output available for this run.</div>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

function ConfigField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm text-text-primary">{value || <span className="text-text-muted">-</span>}</div>
    </div>
  );
}
