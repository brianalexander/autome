import type { NodeTypeInfo } from './api';

// Map node type IDs to UI groups
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

const GROUP_ORDER = ['Triggers', 'AI & Agents', 'Logic', 'Data'];

export interface NodeEntry {
  type: string;
  label: string;
  icon: string; // Lucide icon name from the backend spec
  description: string;
  category: string; // UI group label
}

export interface NodeCategory {
  label: string;
  nodes: NodeEntry[];
}

/** Build categorized node entries from backend node type specs */
export function buildNodeCategories(nodeTypeList: NodeTypeInfo[]): NodeCategory[] {
  const groupMap = new Map<string, NodeEntry[]>();

  for (const nt of nodeTypeList) {
    const group = UI_GROUP_MAP[nt.id] ?? (nt.category === 'trigger' ? 'Triggers' : 'Other');
    if (!groupMap.has(group)) {
      groupMap.set(group, []);
    }
    groupMap.get(group)!.push({
      type: nt.id,
      label: nt.name,
      icon: nt.icon,
      description: nt.description,
      category: group,
    });
  }

  // Known groups first, then any extras (e.g. 'Other')
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

/** Flatten categories into a single searchable list */
export function flattenNodeEntries(categories: NodeCategory[]): NodeEntry[] {
  return categories.flatMap(cat => cat.nodes);
}
