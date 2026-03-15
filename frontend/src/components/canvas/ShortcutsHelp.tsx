import { useEffect } from 'react';
import { X } from 'lucide-react';
import { isMac } from '../../hooks/useKeyboardShortcuts';

interface ShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const MOD_KEY = isMac ? '⌘' : 'Ctrl';

const SHORTCUT_GROUPS = [
  {
    label: 'General',
    shortcuts: [
      { keys: `${MOD_KEY}+K`, description: 'Quick add node' },
      { keys: `${MOD_KEY}+S`, description: 'Save workflow' },
      { keys: `${MOD_KEY}+Z`, description: 'Undo' },
      { keys: `${MOD_KEY}+⇧+Z`, description: 'Redo' },
      { keys: '?', description: 'Show shortcuts' },
    ],
  },
  {
    label: 'Canvas',
    shortcuts: [
      { keys: 'Delete / ⌫', description: 'Delete selected' },
      { keys: `${MOD_KEY}+A`, description: 'Select all nodes' },
      { keys: `${MOD_KEY}+⇧+F`, description: 'Fit view' },
      { keys: `${MOD_KEY}+L`, description: 'Re-layout graph' },
      { keys: 'Escape', description: 'Deselect / close panel' },
    ],
  },
  {
    label: 'Sidebar',
    shortcuts: [
      { keys: '1', description: 'Toggle AI Author' },
      { keys: '2', description: 'Toggle Node Palette' },
      { keys: '3', description: 'Toggle Settings' },
    ],
  },
];

export function ShortcutsHelp({ isOpen, onClose }: ShortcutsHelpProps) {
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

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[400px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Keyboard Shortcuts
          </h3>
          <button
            onClick={onClose}
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcut groups */}
        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-2">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.shortcuts.map((s) => (
                  <div key={s.keys} className="flex items-center justify-between py-1">
                    <span className="text-sm text-[var(--color-text-secondary)]">
                      {s.description}
                    </span>
                    <kbd className="text-xs font-mono text-[var(--color-text-tertiary)] bg-[var(--color-surface-tertiary)] px-2 py-0.5 rounded border border-[var(--color-border)]">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
