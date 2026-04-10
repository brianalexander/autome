/**
 * GenericStepNode — unified canvas node renderer.
 * Shows: icon + label + description + status.
 * All content is author-set (label, description), not derived from config.
 */
import { memo, type ReactNode } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Zap, FileText } from 'lucide-react';
import { RunningTimer } from '../../ui/RunningTimer';
import { BaseNode } from './BaseNode';
import { resolveLucideIcon } from '../../../lib/iconResolver';

/** Resolve a Lucide icon name to a React node, falling back to Zap */
function resolveIcon(name?: string): ReactNode {
  if (!name) return <Zap className="w-4 h-4" strokeWidth={1.75} />;
  const Icon = resolveLucideIcon(name);
  if (Icon) return <Icon className="w-4 h-4" strokeWidth={1.75} />;
  return <Zap className="w-4 h-4" strokeWidth={1.75} />;
}

interface GenericNodeData {
  label: string;
  hasReadme?: boolean;
  category?: 'trigger' | 'step';
  icon?: string;
  color?: { bg?: string; border?: string; text?: string };
  // Legacy flat color props (kept for compatibility)
  colorBg?: string;
  colorBorder?: string;
  colorText?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
  duration?: string;
  startedAt?: string;
  // Author-mode toolbar callbacks
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onEdit?: (id: string) => void;
  isAuthor?: boolean;
}

const STATUS_CONFIG: Record<string, { dot: string; text: string }> = {
  pending:   { dot: 'bg-slate-400',              text: 'text-slate-400' },
  running:   { dot: 'bg-blue-500 status-pulse',  text: 'text-blue-400' },
  completed: { dot: 'bg-emerald-500',             text: 'text-emerald-400' },
  failed:    { dot: 'bg-red-500',                 text: 'text-red-400' },
  skipped:   { dot: 'bg-slate-500',               text: 'text-slate-500' },
};

export const GenericStepNode = memo(function GenericStepNode({ data, selected, id }: NodeProps) {
  const d = data as unknown as GenericNodeData;
  const status = d.status || 'pending';
  const isRuntime = d.status !== undefined;
  const isTrigger = d.category === 'trigger';
  const accentColor = d.color?.border || d.colorBorder || '#8b5cf6';
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;

  const handleColor = isTrigger ? 'var(--handle-color-trigger)' : 'var(--handle-color-step)';
  const handleGlowClass = isTrigger ? 'handle-glow-amber' : 'handle-glow-purple';

  // Body: runtime status row
  const body = isRuntime ? (
    <div className="px-3.5 py-2 flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} data-testid="status-dot" />
      <span className={`text-xs font-medium ${cfg.text}`}>{status}</span>
      {status === 'running' && d.startedAt ? (
        <RunningTimer startedAt={d.startedAt} className="text-[11px] text-blue-400 font-mono tabular-nums ml-auto" />
      ) : d.duration ? (
        <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono tabular-nums ml-auto">{d.duration}</span>
      ) : null}
    </div>
  ) : null;

  // Footer: error
  const footer = d.error ? (
    <div className="border-t border-[var(--node-border)] px-3.5 py-1.5 text-xs text-red-400 truncate" title={d.error} data-testid="error-display">
      {d.error}
    </div>
  ) : null;

  const headerRight = d.hasReadme ? (
    <span title="Has README">
      <FileText className="w-3 h-3 text-[var(--color-text-tertiary)] flex-shrink-0" />
    </span>
  ) : undefined;

  return (
    <BaseNode
      id={id}
      selected={selected}
      icon={resolveIcon(d.icon)}
      label={d.label}
      headerRight={headerRight}
      headerTint={accentColor}
      handleColor={handleColor}
      handleGlowClass={handleGlowClass}
      showTargetHandle={!isTrigger}
      dimmed={status === 'skipped'}
      body={body}
      footer={footer}
      isAuthor={d.isAuthor}
      onDelete={d.onDelete}
      onDuplicate={d.onDuplicate}
      onEdit={d.onEdit}
      testId="generic-step-node"
    />
  );
});
