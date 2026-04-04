/**
 * Rich tool call card — with collapsible details.
 * Default state: collapsed (single compact line).
 * Auto-expands when in_progress, pending, or pending_approval.
 */
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Wrench, BookOpen, Pencil, Trash2, Search, Zap, Globe, MessageCircle, Bot, ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolCallRecord } from '../../lib/api';
import { formatElapsed } from '../../lib/format';
import { isSubAgentCall, extractSubAgentInfo } from '../../lib/chatUtils';
import { StreamingMarkdown } from './StreamingMarkdown';

// --- Helpers ---

function extractToolInfo(rawInput: string | null): {
  server?: string;
  tool?: string;
  purpose?: string;
  command?: string;
} {
  if (!rawInput) return {};
  try {
    const input = JSON.parse(rawInput);
    const toolName = input.__tool_name as string | undefined;
    const purpose = input.__tool_use_purpose as string | undefined;
    // Extract command for shell/execute tools
    const command = input.command || input.cmd || input.script;
    let server: string | undefined;
    let tool: string | undefined;
    if (toolName && toolName.includes('/')) {
      const parts = toolName.split('/');
      server = parts[0].replace(/^@/, '');
      tool = parts.slice(1).join('/');
    }
    return { server, tool, purpose, command: typeof command === 'string' ? command : undefined };
  } catch {}
  return {};
}


function prettyCompact(value: unknown, indent = 2): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const str = JSON.stringify(value, null, indent);
  return str.replace(/\[\s*\n\s*("[^"]*"(?:,\s*\n\s*"[^"]*")*)\s*\n\s*\]/g, (_, items) => {
    const flat = items.replace(/\s*\n\s*/g, ' ');
    return flat.length < 80 ? `[${flat}]` : _;
  });
}

function parseToolArgs(rawInput: string | null): Record<string, unknown> | null {
  if (!rawInput) return null;
  try {
    const parsed = JSON.parse(rawInput);
    const { __tool_name, __mcp_server, __tool_use_purpose, ...args } = parsed;
    return Object.keys(args).length > 0 ? args : null;
  } catch {
    return null;
  }
}

// --- Status styles ---

const statusStyles: Record<string, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-gray-500', text: 'text-text-tertiary', label: 'pending' },
  in_progress: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-400', label: 'running' },
  completed: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: 'done' },
  failed: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'failed' },
};

const permissionStyles: Record<string, string> = {
  pending_approval: 'text-amber-600 dark:text-amber-400',
  allowed: 'text-green-600 dark:text-green-400',
  rejected: 'text-red-600 dark:text-red-400',
  cancelled: 'text-text-tertiary',
};

function toolKindIcon(kind?: string | null, isAgent?: boolean): ReactNode {
  const cls = "w-3.5 h-3.5";
  if (isAgent) return <Bot className={cls} />;
  if (!kind) return <Wrench className={cls} />;
  const tool = kind.includes('/') ? kind.split('/').pop()! : kind;
  switch (tool) {
    case 'read':
    case 'read_file':
    case 'readTextFile':
      return <BookOpen className={cls} />;
    case 'edit':
    case 'write':
    case 'write_file':
    case 'writeTextFile':
      return <Pencil className={cls} />;
    case 'delete':
      return <Trash2 className={cls} />;
    case 'search':
    case 'grep':
    case 'glob':
      return <Search className={cls} />;
    case 'execute':
    case 'shell':
    case 'bash':
      return <Zap className={cls} />;
    case 'fetch':
      return <Globe className={cls} />;
    case 'think':
      return <MessageCircle className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

// --- RunningDuration ---
// Small component with its own interval so elapsed time ticks for running children
// without requiring the parent to manage their timers.

function RunningDuration({ startMs, className }: { startMs: number; className?: string }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, (Date.now() - startMs) / 1000));
  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, (Date.now() - startMs) / 1000));
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return <span className={className}>{formatElapsed(elapsed)}</span>;
}

// --- Main Component ---

export function ToolCallCard({
  toolCall,
  onPermissionResponse,
  childToolCalls,
}: {
  toolCall: ToolCallRecord;
  onPermissionResponse?: (toolCallId: string, optionId: string) => void;
  childToolCalls?: ToolCallRecord[];
}) {
  const [showIO, setShowIO] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const isRunning = toolCall.status === 'in_progress' || toolCall.status === 'pending';
  const isAgent = isSubAgentCall(toolCall);
  const subAgentInfo = isAgent ? extractSubAgentInfo(toolCall.raw_input) : null;
  const { server, tool, purpose, command } = extractToolInfo(toolCall.raw_input);
  const args = parseToolArgs(toolCall.raw_input);
  const output = toolCall.raw_output ? tryParse(toolCall.raw_output) : null;
  const style = statusStyles[toolCall.status] || statusStyles.pending;

  // Auto-expand when running or awaiting permission
  const [expanded, setExpanded] = useState(
    isRunning || toolCall.permission_status === 'pending_approval'
  );

  // Keep expanded when status transitions to running
  useEffect(() => {
    if (isRunning || toolCall.permission_status === 'pending_approval') {
      setExpanded(true);
    }
  }, [isRunning, toolCall.permission_status]);

  // Elapsed timer
  useEffect(() => {
    if (!isRunning) {
      const start = new Date(toolCall.created_at).getTime();
      const end = new Date(toolCall.updated_at).getTime();
      setElapsed(Math.max(0, (end - start) / 1000));
      return;
    }
    const start = new Date(toolCall.created_at).getTime();
    const tick = () => setElapsed(Math.max(0, (Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning, toolCall.created_at, toolCall.updated_at]);

  const rawTitle = toolCall.title && toolCall.title !== 'undefined' && toolCall.title !== '"undefined"'
    ? toolCall.title
    : null;
  const displayName = isAgent && subAgentInfo?.description
    ? subAgentInfo.description
    : server && tool ? `@${server}/${tool}` : rawTitle || toolCall.kind || 'Tool call';

  const commandStr = command != null && command !== '' ? command : null;

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface/50">
      {/* Collapsed header row — always visible, click to toggle */}
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-surface-secondary/50 select-text w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-text-tertiary flex-shrink-0">{toolKindIcon(toolCall.kind, isAgent)}</span>
        <span className="text-text-primary font-medium font-mono truncate flex-1 text-left">{displayName}</span>

        {/* Exit code badge — only show when collapsed and non-zero */}
        {!expanded && toolCall.exit_code != null && toolCall.exit_code !== 0 && (
          <span className="text-[10px] bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded font-mono flex-shrink-0">
            exit {toolCall.exit_code}
          </span>
        )}

        {/* Status dot */}
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        </span>

        {/* Child count badge — collapsed agent */}
        {!expanded && isAgent && childToolCalls && childToolCalls.length > 0 && (
          <span className="text-[10px] text-text-muted flex-shrink-0">
            {childToolCalls.length} tool{childToolCalls.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* Duration */}
        <span
          className={`text-[10px] font-mono tabular-nums flex-shrink-0 ${isRunning ? 'text-blue-400' : 'text-text-muted'}`}
        >
          {formatElapsed(elapsed)}
        </span>

        {expanded ? (
          <ChevronDown className="w-3 h-3 text-text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-tertiary flex-shrink-0" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div>
          {/* Exit code badge in expanded view */}
          {toolCall.exit_code != null && toolCall.exit_code !== 0 && (
            <div className="px-3 pb-1 -mt-0.5">
              <span className="text-[10px] bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded font-mono">
                exit {toolCall.exit_code}
              </span>
            </div>
          )}

          {/* Sub-agent type badge */}
          {isAgent && subAgentInfo?.type && (
            <div className="px-3 pb-1.5 -mt-0.5">
              <span className="text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded font-mono">
                {subAgentInfo.type}
              </span>
            </div>
          )}

          {/* Sub-agent child tool calls */}
          {isAgent && childToolCalls && childToolCalls.length > 0 && (
            <div className="px-3 pb-2">
              <div className="border border-border-subtle rounded-md overflow-hidden divide-y divide-border-subtle">
                {childToolCalls.map((child) => {
                  const childInfo = extractToolInfo(child.raw_input);
                  const childStyle = statusStyles[child.status] || statusStyles.pending;
                  const childIsRunning = child.status === 'in_progress' || child.status === 'pending';
                  const childDisplayName = childInfo.server && childInfo.tool
                    ? `@${childInfo.server}/${childInfo.tool}`
                    : child.title || 'Tool call';
                  const childStart = new Date(child.created_at).getTime();
                  const childEnd = new Date(child.updated_at).getTime();
                  const completedDuration = Math.max(0, (childEnd - childStart) / 1000);

                  return (
                    <div
                      key={child.id}
                      className="flex items-center gap-2 px-2.5 py-1 text-[11px]"
                    >
                      <span className="text-text-tertiary flex-shrink-0">
                        {toolKindIcon(child.kind)}
                      </span>
                      <span className="text-text-secondary font-mono truncate flex-1">
                        {childDisplayName}
                      </span>
                      {child.exit_code != null && child.exit_code !== 0 && (
                        <span className="text-[9px] bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 px-1 py-0.5 rounded font-mono flex-shrink-0">
                          exit {child.exit_code}
                        </span>
                      )}
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${childStyle.dot}`} />
                      {childIsRunning ? (
                        <RunningDuration
                          startMs={childStart}
                          className="text-[10px] font-mono tabular-nums flex-shrink-0 text-blue-400"
                        />
                      ) : (
                        <span className="text-[10px] font-mono tabular-nums flex-shrink-0 text-text-muted">
                          {formatElapsed(completedDuration)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Reason — shown if __tool_use_purpose exists */}
          {purpose && (
            <div className="px-3 pb-2 -mt-0.5">
              <span className="text-[11px] text-text-secondary">
                <span className="text-blue-400 font-medium">Reason: </span>
                {purpose}
              </span>
            </div>
          )}

          {/* Command preview — for shell/execute tools */}
          {commandStr && (
            <div className="px-3 pb-2 -mt-0.5">
              <pre className="text-[11px] text-text-secondary font-mono bg-surface-secondary rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap max-h-16 overflow-y-auto">
                {commandStr.length > 200 ? commandStr.slice(0, 200) + '...' : commandStr}
              </pre>
            </div>
          )}

          {/* Permission approval buttons */}
          {toolCall.permission_status === 'pending_approval' && toolCall.permission_options && onPermissionResponse && (
            <div className="px-3 py-2 border-t border-border bg-amber-50 dark:bg-amber-950/20">
              <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-2">Tool requires approval</div>
              <div className="flex gap-2 flex-wrap">
                {toolCall.permission_options.map((opt) => (
                  <button
                    key={opt.optionId}
                    onClick={() => onPermissionResponse(toolCall.id, opt.optionId)}
                    className={`px-2 py-1 text-[10px] rounded border ${
                      opt.kind === 'allow_once' || opt.kind === 'allow_session'
                        ? 'border-green-300 dark:border-green-700 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/30'
                        : opt.kind === 'deny'
                          ? 'border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
                          : 'border-border-subtle text-text-secondary hover:bg-surface-tertiary'
                    }`}
                  >
                    {opt.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Permission decision badge */}
          {toolCall.permission_status && toolCall.permission_status !== 'pending_approval' && (
            <div className="px-3 py-1.5 border-t border-border">
              <span className={`text-[10px] ${permissionStyles[toolCall.permission_status] || 'text-text-tertiary'}`}>
                {toolCall.permission_status === 'allowed'
                  ? '\u2713 Allowed'
                  : toolCall.permission_status === 'rejected'
                    ? '\u2717 Denied'
                    : toolCall.permission_status === 'cancelled'
                      ? '\u2717 Cancelled'
                      : toolCall.permission_status}
              </span>
            </div>
          )}

          {/* Output preview — brief summary visible when completed */}
          {!!output && !isRunning && (
            <div className="px-3 pb-2 -mt-0.5">
              {isAgent ? (
                <div className="text-[11px] max-h-40 overflow-y-auto">
                  <StreamingMarkdown content={typeof output === 'string' ? output : JSON.stringify(output, null, 2)} />
                </div>
              ) : (
                <pre className="text-[11px] text-text-secondary font-mono bg-surface-secondary rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap max-h-20 overflow-y-auto">
                  {(() => {
                    const str = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
                    return str.length > 300 ? str.slice(0, 300) + '...' : str;
                  })()}
                </pre>
              )}
            </div>
          )}

          {/* Footer — toggle raw I/O (icon button) */}
          {(args != null || !!output) && (
            <div className="border-t border-border">
              <button
                onClick={(e) => { e.stopPropagation(); setShowIO(!showIO); }}
                className="flex items-center gap-1 px-3 py-1.5 text-[10px] text-text-tertiary hover:text-text-secondary hover:bg-surface-secondary/50 transition-colors"
                title={showIO ? 'Hide Raw I/O' : 'Show Raw I/O'}
              >
                {showIO ? 'Hide details' : 'Show details'}
                <ChevronDown className={`w-2.5 h-2.5 transition-transform ${showIO ? '' : '-rotate-90'}`} />
              </button>

              {showIO && (
                <div className="divide-y divide-border/50">
                  {args && (
                    <div className="px-3 py-2">
                      <div className="text-[10px] text-text-tertiary mb-1.5 uppercase tracking-wider">
                        {isAgent ? 'Prompt' : 'Input'}
                      </div>
                      {isAgent && subAgentInfo?.prompt ? (
                        <div className="text-[11px] text-text-secondary bg-surface-secondary rounded p-2.5 overflow-x-auto max-h-48 overflow-y-auto leading-relaxed whitespace-pre-wrap">
                          {subAgentInfo.prompt.length > 500 ? subAgentInfo.prompt.slice(0, 500) + '...' : subAgentInfo.prompt}
                        </div>
                      ) : (
                        <pre className="text-[11px] text-text-secondary bg-surface-secondary rounded p-2.5 overflow-x-auto max-h-48 overflow-y-auto font-mono leading-relaxed whitespace-pre-wrap">
                          {prettyCompact(args)}
                        </pre>
                      )}
                    </div>
                  )}
                  {!!output && (
                    <div className="px-3 py-2">
                      <div className="text-[10px] text-text-tertiary mb-1.5 uppercase tracking-wider">Output</div>
                      {isAgent ? (
                        <div className="text-[11px] bg-surface-secondary rounded p-2.5 overflow-x-auto max-h-48 overflow-y-auto">
                          <StreamingMarkdown content={typeof output === 'string' ? output : JSON.stringify(output, null, 2)} />
                        </div>
                      ) : (
                        <pre className="text-[11px] text-text-secondary bg-surface-secondary rounded p-2.5 overflow-x-auto max-h-48 overflow-y-auto font-mono leading-relaxed whitespace-pre-wrap">
                          {typeof output === 'string' ? output : prettyCompact(output)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
