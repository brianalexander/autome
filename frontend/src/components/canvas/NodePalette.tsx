import { useState, useMemo } from 'react';
import { Search, Play, Webhook, Clock, Bot, ShieldCheck, Code, Shuffle, Globe, Terminal, Plug, type LucideIcon } from 'lucide-react';
import { useNodeTypes } from '../../hooks/queries';
import type { NodeTypeInfo } from '../../lib/api';

// Map node type IDs to UI groups for nice organization
const UI_GROUP_MAP: Record<string, string> = {
  'manual-trigger': 'Triggers',
  'webhook-trigger': 'Triggers',
  'cron-trigger': 'Triggers',
  'code-trigger': 'Triggers',
  'agent': 'AI & Agents',
  'gate': 'Logic',
  'code-executor': 'Logic',
  'shell-executor': 'Logic',
  'transform': 'Data',
  'http-request': 'Data',
};

// Ordering for UI groups
const GROUP_ORDER = ['Triggers', 'AI & Agents', 'Logic', 'Data'];

const ICON_MAP: Record<string, LucideIcon> = {
  'manual-trigger': Play,
  'webhook-trigger': Webhook,
  'cron-trigger': Clock,
  'code-trigger': Plug,
  'agent': Bot,
  'gate': ShieldCheck,
  'code-executor': Code,
  'shell-executor': Terminal,
  'transform': Shuffle,
  'http-request': Globe,
};

interface NodeEntry {
  type: string;
  label: string;
  lucideIcon: LucideIcon | null;
  emojiIcon: string;
  description: string;
}

interface NodeCategory {
  label: string;
  nodes: NodeEntry[];
}

function buildCategories(nodeTypeList: NodeTypeInfo[]): NodeCategory[] {
  const groupMap = new Map<string, NodeEntry[]>();

  for (const nt of nodeTypeList) {
    const group = UI_GROUP_MAP[nt.id] ?? (nt.category === 'trigger' ? 'Triggers' : 'Other');
    if (!groupMap.has(group)) {
      groupMap.set(group, []);
    }
    groupMap.get(group)!.push({
      type: nt.id,
      label: nt.name,
      lucideIcon: ICON_MAP[nt.id] ?? null,
      emojiIcon: nt.icon,
      description: nt.description,
    });
  }

  // Build ordered array: known groups first, then any extras (e.g. 'Other')
  const ordered: NodeCategory[] = [];
  for (const groupLabel of GROUP_ORDER) {
    if (groupMap.has(groupLabel)) {
      ordered.push({ label: groupLabel, nodes: groupMap.get(groupLabel)! });
    }
  }
  for (const [groupLabel, nodes] of groupMap) {
    if (!GROUP_ORDER.includes(groupLabel)) {
      ordered.push({ label: groupLabel, nodes });
    }
  }

  return ordered;
}

interface NodePaletteProps {
  onAddNode: (type: string) => void;
}

export function NodePalette({ onAddNode }: NodePaletteProps) {
  const [search, setSearch] = useState('');
  const { data: nodeTypeList, isLoading } = useNodeTypes();

  const categories = useMemo(() => {
    if (!nodeTypeList) return [];
    return buildCategories(nodeTypeList);
  }, [nodeTypeList]);

  const filtered = categories.map((cat) => ({
    ...cat,
    nodes: cat.nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(search.toLowerCase()) ||
        n.description.toLowerCase().includes(search.toLowerCase()),
    ),
  })).filter((cat) => cat.nodes.length > 0);

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-[var(--color-border)]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
          <input
            type="text"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {isLoading ? (
          <div className="px-2 py-4 text-sm text-[var(--color-text-tertiary)]">Loading...</div>
        ) : (
          filtered.map((cat) => (
            <div key={cat.label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] px-2 mb-1.5">
                {cat.label}
              </div>
              <div className="space-y-0.5">
                {cat.nodes.map((node) => (
                  <button
                    key={node.type}
                    onClick={() => onAddNode(node.type)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-[var(--color-interactive)] group"
                  >
                    <div className="flex-shrink-0 w-5 flex items-center justify-center">
                      {node.lucideIcon ? (
                        <node.lucideIcon className="w-4 h-4 text-[var(--color-text-secondary)]" strokeWidth={1.75} />
                      ) : (
                        <span className="w-4 h-4 text-sm leading-none flex items-center justify-center">
                          {node.emojiIcon}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)]">
                        {node.label}
                      </div>
                      <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                        {node.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
