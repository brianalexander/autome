import { useEffect, useCallback } from 'react';

interface ShortcutHandlers {
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onDelete?: () => void;
  onSelectAll?: () => void;
  onEscape?: () => void;
  onCommandPalette?: () => void;
  onFitView?: () => void;
  onToggleAuthor?: () => void;
  onToggleNodes?: () => void;
  onToggleSettings?: () => void;
  onRelayout?: () => void;
  onShortcutsHelp?: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? 'metaKey' : 'ctrlKey';

export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled: boolean = true) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      // Don't trigger shortcuts when typing in inputs/textareas
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      const mod = e[MOD as keyof KeyboardEvent] as boolean;
      const key = e.key.toLowerCase();

      // ⌘K / Ctrl+K — Command palette (always active, even in inputs)
      if (mod && key === 'k') {
        e.preventDefault();
        handlers.onCommandPalette?.();
        return;
      }

      // ⌘S / Ctrl+S — Save (always active)
      if (mod && key === 's') {
        e.preventDefault();
        handlers.onSave?.();
        return;
      }

      // Skip other shortcuts when in inputs
      if (isInput) return;

      // ⌘Z / Ctrl+Z — Undo
      if (mod && !e.shiftKey && key === 'z') {
        e.preventDefault();
        handlers.onUndo?.();
        return;
      }

      // ⌘⇧Z / Ctrl+Shift+Z or Ctrl+Y — Redo
      if ((mod && e.shiftKey && key === 'z') || (mod && key === 'y')) {
        e.preventDefault();
        handlers.onRedo?.();
        return;
      }

      // Delete / Backspace — Delete selected (backup for when React Flow loses focus)
      if (key === 'delete' || key === 'backspace') {
        handlers.onDelete?.();
        return;
      }

      // ⌘A / Ctrl+A — Select all
      if (mod && key === 'a') {
        e.preventDefault();
        handlers.onSelectAll?.();
        return;
      }

      // Escape — Deselect / close panels
      if (key === 'escape') {
        handlers.onEscape?.();
        return;
      }

      // ⌘⇧F / Ctrl+Shift+F — Fit view
      if (mod && e.shiftKey && key === 'f') {
        e.preventDefault();
        handlers.onFitView?.();
        return;
      }

      // ⌘L / Ctrl+L — Re-layout
      if (mod && key === 'l') {
        e.preventDefault();
        handlers.onRelayout?.();
        return;
      }

      // 1, 2, 3 — Toggle sidebar tabs (without modifier)
      if (key === '1' && !mod) {
        handlers.onToggleAuthor?.();
        return;
      }
      if (key === '2' && !mod) {
        handlers.onToggleNodes?.();
        return;
      }
      if (key === '3' && !mod) {
        handlers.onToggleSettings?.();
        return;
      }

      // ? — Show shortcuts help
      if (key === '?' || (e.shiftKey && key === '/')) {
        handlers.onShortcutsHelp?.();
        return;
      }
    },
    [enabled, handlers],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export { isMac };
