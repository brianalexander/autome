import { useCallback, useReducer, useEffect } from 'react';

const MAX_HISTORY = 50;

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

type Action<T> =
  | { type: 'PUSH'; value: T }
  | { type: 'SET'; value: T }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESET'; value: T };

function reducer<T>(state: HistoryState<T>, action: Action<T>): HistoryState<T> {
  switch (action.type) {
    case 'PUSH':
      // Skip duplicate pushes — avoids phantom history entries from no-op changes.
      // Reference equality is sufficient: ConfigPanel always produces a new object when
      // the value actually changed, and the debounce already prevents rapid-fire pushes.
      if (action.value === state.present) return state;
      return {
        past: [...state.past.slice(-(MAX_HISTORY - 1)), state.present],
        present: action.value,
        future: [],
      };
    case 'SET':
      // Update present without affecting history (e.g., for keystroke-level changes)
      return { ...state, present: action.value };
    case 'UNDO': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future].slice(0, MAX_HISTORY),
      };
    }
    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        past: [...state.past, state.present].slice(-MAX_HISTORY),
        present: next,
        future: state.future.slice(1),
      };
    }
    case 'RESET':
      return { past: [], present: action.value, future: [] };
    default:
      return state;
  }
}

/**
 * Hook providing undo/redo for a value using useReducer for atomic state transitions.
 * Returns the current value, a push function, undo/redo, and status flags.
 * Keyboard shortcuts (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z) are automatically bound.
 */
export function useUndoRedo<T>(initialValue: T) {
  const [state, dispatch] = useReducer(reducer<T>, {
    past: [],
    present: initialValue,
    future: [],
  });

  const pushState = useCallback((value: T) => {
    dispatch({ type: 'PUSH', value });
  }, []);

  /** Update present without creating a history entry (e.g., per-keystroke edits). */
  const set = useCallback((value: T) => {
    dispatch({ type: 'SET', value });
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: 'UNDO' });
  }, []);

  const redo = useCallback(() => {
    dispatch({ type: 'REDO' });
  }, []);

  const reset = useCallback((value: T) => {
    dispatch({ type: 'RESET', value });
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo), Ctrl+Y (redo on Windows)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement;
      // Don't intercept when the user is in any editable context
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable ||
        target.closest('.cm-editor') ||
        target.closest('[contenteditable]')
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      if (key === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' });
      } else if (key === 'y' && !e.metaKey) {
        // Ctrl+Y redo (Windows convention, not Cmd+Y on Mac)
        e.preventDefault();
        dispatch({ type: 'REDO' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return {
    current: state.present as T,
    pushState,
    set,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    reset,
  };
}
