import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, Bookmark } from 'lucide-react';
import { useNodeTypes, useTemplates } from '../../hooks/queries';
import type { NodeTemplateRecord } from '../../lib/api';
import { buildNodeCategories, flattenNodeEntries } from '../../lib/nodeRegistry';
import { resolveLucideIcon } from '../../lib/iconResolver';

interface PaletteItem {
  /** Unique key for the result list */
  key: string;
  label: string;
  description: string;
  icon: string;
  /** Shown as a subtle tag on the right */
  category: string;
  kind: 'node' | 'template';
  /** For nodes: the node type ID. For templates: unused. */
  nodeType?: string;
  /** For templates: the full template record. */
  template?: NodeTemplateRecord;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onAddNode: (type: string) => void;
  onAddTemplate?: (template: NodeTemplateRecord) => void;
}

export function CommandPalette({ isOpen, onClose, onAddNode, onAddTemplate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: nodeTypeList } = useNodeTypes();
  const { data: templateList } = useTemplates();

  // Build unified list: node types first, then templates
  const allItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];

    // Node types
    if (nodeTypeList) {
      for (const entry of flattenNodeEntries(buildNodeCategories(nodeTypeList))) {
        items.push({
          key: `node:${entry.type}`,
          label: entry.label,
          description: entry.description,
          icon: entry.icon,
          category: entry.category,
          kind: 'node',
          nodeType: entry.type,
        });
      }
    }

    // Templates
    if (templateList) {
      for (const tmpl of templateList) {
        items.push({
          key: `template:${tmpl.id}`,
          label: tmpl.name,
          description: tmpl.description || `${tmpl.node_type} template`,
          icon: tmpl.icon || 'bookmark',
          category: 'Template',
          kind: 'template',
          template: tmpl,
        });
      }
    }

    return items;
  }, [nodeTypeList, templateList]);

  const filtered = query.trim()
    ? allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(query.toLowerCase()) ||
          item.description.toLowerCase().includes(query.toLowerCase()) ||
          item.category.toLowerCase().includes(query.toLowerCase()),
      )
    : allItems;

  // Capture-phase Escape listener — fires before the global shortcut handler
  // so closing the palette doesn't also deselect nodes.
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'template' && item.template && onAddTemplate) {
        onAddTemplate(item.template);
      } else if (item.kind === 'node' && item.nodeType) {
        onAddNode(item.nodeType);
      }
      onClose();
    },
    [onAddNode, onAddTemplate, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        e.preventDefault();
        handleSelect(filtered[selectedIndex]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [filtered, selectedIndex, handleSelect, onClose],
  );

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />

      {/* Palette */}
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 z-50 w-[480px] max-h-[400px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          <Search className="w-4 h-4 text-[var(--color-text-tertiary)] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search nodes and templates..."
            className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none"
          />
          <kbd className="text-[10px] text-[var(--color-text-tertiary)] bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 rounded font-mono">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1 py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--color-text-tertiary)]">
              No matching nodes or templates found
            </div>
          ) : (
            filtered.map((item, i) => {
              const Icon = item.kind === 'template' && item.icon === 'bookmark'
                ? Bookmark
                : resolveLucideIcon(item.icon);
              const isSelected = i === selectedIndex;
              return (
                <button
                  key={item.key}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)]'
                  }`}
                >
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                      isSelected ? 'bg-white/20' : 'bg-[var(--color-surface-tertiary)]'
                    }`}
                  >
                    {Icon ? <Icon className="w-4 h-4" strokeWidth={1.75} /> : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{item.label}</div>
                    <div
                      className={`text-xs truncate ${isSelected ? 'text-white/70' : 'text-[var(--color-text-tertiary)]'}`}
                    >
                      {item.description}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] flex-shrink-0 ${isSelected ? 'text-white/50' : 'text-[var(--color-text-tertiary)]'}`}
                  >
                    {item.category}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
