import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useNodeTypes } from '../../hooks/queries';
import { buildNodeCategories, flattenNodeEntries } from '../../lib/nodeRegistry';
import { resolveLucideIcon } from '../../lib/iconResolver';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onAddNode: (type: string) => void;
}

export function CommandPalette({ isOpen, onClose, onAddNode }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: nodeTypeList } = useNodeTypes();

  const allNodes = useMemo(() => {
    if (!nodeTypeList) return [];
    return flattenNodeEntries(buildNodeCategories(nodeTypeList));
  }, [nodeTypeList]);

  const filtered = query.trim()
    ? allNodes.filter(
        (n) =>
          n.label.toLowerCase().includes(query.toLowerCase()) ||
          n.description.toLowerCase().includes(query.toLowerCase()) ||
          n.category.toLowerCase().includes(query.toLowerCase()),
      )
    : allNodes;

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
        onAddNode(filtered[selectedIndex].type);
        onClose();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [filtered, selectedIndex, onAddNode, onClose],
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
            placeholder="Search nodes to add..."
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
              No matching nodes found
            </div>
          ) : (
            filtered.map((item, i) => {
              const Icon = resolveLucideIcon(item.icon);
              const isSelected = i === selectedIndex;
              return (
                <button
                  key={item.type}
                  onClick={() => {
                    onAddNode(item.type);
                    onClose();
                  }}
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
                    className={`text-[10px] ${isSelected ? 'text-white/50' : 'text-[var(--color-text-tertiary)]'}`}
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
