import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Bot } from 'lucide-react';
import { RunningTimer } from '../../ui/RunningTimer';
import { BaseNode } from './BaseNode';

interface AgentNodeData {
  label: string;
  stageId?: string;
  description?: string;
  agentId: string;
  agentDescription?: string;
  model?: string;
  mcpServers?: string[];
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  runCount?: number;
  maxIterations?: number;
  onJumpIn?: () => void;
  outputSummary?: string;
  error?: string;
  duration?: string;
  startedAt?: string;
  isInCycle?: boolean;
  cycleBehavior?: string;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onEdit?: (id: string) => void;
  isAuthor?: boolean;
}

const STATUS_CONFIG = {
  pending:   { dot: 'bg-slate-400',                  text: 'text-slate-400',   label: 'Idle' },
  running:   { dot: 'bg-blue-500 status-pulse',       text: 'text-blue-400',    label: 'Running' },
  completed: { dot: 'bg-emerald-500',                 text: 'text-emerald-400', label: 'Done' },
  failed:    { dot: 'bg-red-500',                     text: 'text-red-400',     label: 'Failed' },
  skipped:   { dot: 'bg-slate-500',                   text: 'text-slate-500',   label: 'Skipped' },
} as const;

export const AgentStageNode = memo(function AgentStageNode({ data, selected, id }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const status = (d.status || 'pending') as keyof typeof STATUS_CONFIG;
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const isRunning = status === 'running';
  const hasAgentId = d.agentId && d.agentId !== 'unset';

  // Build subtitle: description > agentId > fallback
  const subtitle = d.description || (hasAgentId ? d.agentId : undefined);
  const subtitleItalic = !d.description && !hasAgentId;
  const subtitleText = subtitle || 'No agent configured';

  // Header right: iteration count + timer/duration
  const headerRight = (
    <>
      {d.runCount != null && d.runCount > 0 && (
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono tabular-nums flex-shrink-0">
          {d.runCount}{d.maxIterations ? `/${d.maxIterations}` : ''}
        </span>
      )}
      {d.startedAt && isRunning ? (
        <RunningTimer startedAt={d.startedAt} className="text-[11px] text-blue-400 font-mono tabular-nums flex-shrink-0" />
      ) : d.duration ? (
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono tabular-nums flex-shrink-0">{d.duration}</span>
      ) : null}
    </>
  );

  // Body: runtime status row
  const body = d.status ? (
    <div className="px-3.5 py-2 flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} data-testid="status-dot" />
      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
    </div>
  ) : null;

  // Footer: output preview or error
  const footer = (
    <>
      {status === 'completed' && d.outputSummary && (
        <div className="border-t border-[var(--node-border)] px-3.5 py-2 text-xs text-emerald-400/90 font-mono line-clamp-2" data-testid="output-preview">
          ✓ {d.outputSummary}
        </div>
      )}
      {status === 'failed' && d.error && (
        <div className="border-t border-[var(--node-border)] px-3.5 py-2 text-xs text-red-400 line-clamp-2" data-testid="error-display">
          ✕ {d.error}
        </div>
      )}
    </>
  );

  return (
    <BaseNode
      id={id}
      selected={selected}
      icon={<Bot className="w-4 h-4" strokeWidth={1.75} />}
      label={d.label}
      subtitle={subtitleText}
      subtitleItalic={subtitleItalic}
      headerTint="#3b82f6"
      handleColor="var(--handle-color-agent)"
      handleGlowClass="handle-glow-blue"
      dimmed={status === 'skipped'}
      headerRight={headerRight}
      body={body}
      footer={footer}
      isAuthor={d.isAuthor}
      onDelete={d.onDelete}
      onDuplicate={d.onDuplicate}
      onEdit={d.onEdit}
      testId="agent-stage-node"
    />
  );
});
