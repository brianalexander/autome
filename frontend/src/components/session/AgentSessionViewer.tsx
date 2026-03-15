/**
 * AgentSessionViewer — Wrapper around AcpChatPane for viewing agent stage sessions.
 * Adds: header with status/tabs, iteration picker, config tab, prompt tab, stage output display.
 * Loads persisted transcript segments so chat history survives navigation.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { useCancelStage, useAgent, useInjectMessage, useSegments, useStagePrompt } from '../../hooks/queries';
import { AcpChatPane } from '../chat/AcpChatPane';
import { segmentsToMessages } from '../../lib/segmentsToMessages';
import { instances } from '../../lib/api';
import { formatDuration, formatElapsed } from '../../lib/format';
import { StatusBadge } from '../ui/StatusBadge';
import { SectionHeader } from '../ui/SectionHeader';
import type { StageContext, StageRun, StageDefinition } from '../../lib/api';

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
  const [activeTab, setActiveTab] = useState<'chat' | 'prompt' | 'config'>('chat');
  const [selectedRunIndex, setSelectedRunIndex] = useState<number>(stageContext.runs.length - 1);
  const [copied, setCopied] = useState(false);
  const cancelStage = useCancelStage();
  const injectMessage = useInjectMessage();
  const stageCfg = (stageDef?.config || {}) as Record<string, any>;
  const agentId = stageCfg.agentId || '';
  const { data: agentInfo } = useAgent(agentId);

  const isRunning = stageContext.status === 'running';
  const runs = stageContext.runs;
  const hasMultipleRuns = runs.length > 1;
  const runIdx = Math.min(Math.max(selectedRunIndex, 0), runs.length - 1);
  const selectedRun: StageRun | undefined = runs.length > 0 ? runs[runIdx] : undefined;

  // Load persisted segments for this stage
  const { data: segments } = useSegments(instanceId, stageId);

  // Load rendered prompt
  const { data: promptData } = useStagePrompt(instanceId, stageId);

  // Convert segments to initialMessages format for AcpChatPane
  const initialMessages = useMemo(() => {
    if (!segments?.length) return undefined;
    return segmentsToMessages(segments);
  }, [segments]);

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
    await instances.restartSession(instanceId, stageId);
  }, [instanceId, stageId]);

  const handleCopyConfig = useCallback(() => {
    const data = { stageDef, agentSpec: agentInfo?.spec };
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [stageDef, agentInfo]);

  const duration =
    selectedRun?.started_at && selectedRun?.completed_at
      ? formatDuration(selectedRun.started_at, selectedRun.completed_at)
      : isRunning && elapsed > 0
        ? formatElapsed(elapsed)
        : null;

  const toolsList = toToolsList(agentInfo?.spec?.tools);
  const allowedToolsList = toToolsList(agentInfo?.spec?.allowedTools);

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
        </div>
      </div>

      {/* Prompt tab — shows the rendered prompt sent to this agent */}
      {activeTab === 'prompt' && (
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
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
      )}

      {/* Config tab */}
      {activeTab === 'config' && (
        stageDef ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
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

            {agentInfo?.spec?.mcpServers && Object.keys(agentInfo.spec.mcpServers).length > 0 && (
              <>
                <SectionHeader>MCP Servers</SectionHeader>
                <div className="space-y-2">
                  {Object.entries(agentInfo.spec.mcpServers).map(([name, config]) => (
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

            {agentInfo?.spec?.resources && agentInfo.spec.resources.length > 0 && (
              <>
                <SectionHeader>Resources</SectionHeader>
                <div className="space-y-1">
                  {agentInfo.spec.resources.map((r) => (
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
        )
      )}

      {activeTab === 'chat' && (
        /* Chat tab — delegates to shared AcpChatPane */
        <div className="flex-1 min-h-0 overflow-hidden">
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
      )}
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
