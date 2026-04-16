import { useState, useMemo } from 'react';
import { Search, Bookmark } from 'lucide-react';
import { useNodeTypes, useTemplates } from '../../hooks/queries';
import type { NodeTemplateRecord } from '../../lib/api';
import { buildNodeCategories } from '../../lib/nodeRegistry';
import { resolveLucideIcon } from '../../lib/iconResolver';

interface NodePaletteProps {
  onAddNode: (type: string) => void;
  onAddTemplate?: (template: NodeTemplateRecord) => void;
}

export function NodePalette({ onAddNode, onAddTemplate }: NodePaletteProps) {
  const [search, setSearch] = useState('');
  const { data: nodeTypeList, isLoading } = useNodeTypes();
  const { data: templateList } = useTemplates();

  const categories = useMemo(() => {
    if (!nodeTypeList) return [];
    return buildNodeCategories(nodeTypeList);
  }, [nodeTypeList]);

  const filtered = categories
    .map((cat) => ({
      ...cat,
      nodes: cat.nodes.filter(
        (n) =>
          n.label.toLowerCase().includes(search.toLowerCase()) ||
          n.description.toLowerCase().includes(search.toLowerCase()),
      ),
    }))
    .filter((cat) => cat.nodes.length > 0);

  const filteredTemplates = useMemo(() => {
    if (!templateList) return [];
    if (!search) return templateList;
    const q = search.toLowerCase();
    return templateList.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        t.node_type.toLowerCase().includes(q),
    );
  }, [templateList, search]);

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
          <>
            {filtered.map((cat) => (
              <div key={cat.label}>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] px-2 mb-1.5">
                  {cat.label}
                </div>
                <div className="space-y-0.5">
                  {cat.nodes.map((node) => {
                    const Icon = resolveLucideIcon(node.icon);
                    return (
                      <button
                        key={node.type}
                        onClick={() => onAddNode(node.type)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-[var(--color-interactive)] group"
                      >
                        <div className="flex-shrink-0 w-5 flex items-center justify-center">
                          {Icon ? (
                            <Icon className="w-4 h-4 text-[var(--color-text-secondary)]" strokeWidth={1.75} />
                          ) : null}
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
                    );
                  })}
                </div>
              </div>
            ))}
            {onAddTemplate && filteredTemplates.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] px-2 mb-1.5">
                  Templates
                </div>
                <div className="space-y-0.5">
                  {filteredTemplates.map((tmpl) => {
                    const Icon = tmpl.icon ? resolveLucideIcon(tmpl.icon) : null;
                    return (
                      <button
                        key={tmpl.id}
                        onClick={() => onAddTemplate(tmpl)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-[var(--color-interactive)] group"
                      >
                        <div className="flex-shrink-0 w-5 flex items-center justify-center">
                          {Icon ? (
                            <Icon className="w-4 h-4 text-[var(--color-text-secondary)]" strokeWidth={1.75} />
                          ) : (
                            <Bookmark className="w-4 h-4 text-[var(--color-text-tertiary)]" strokeWidth={1.75} />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)] truncate">
                            {tmpl.name}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                            {tmpl.description ?? tmpl.node_type}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
