import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoRedo } from './useUndoRedo';

describe('useUndoRedo', () => {
  it('starts with the initial value', () => {
    const { result } = renderHook(() => useUndoRedo('initial'));
    expect(result.current.current).toBe('initial');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('pushState creates history entry', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.pushState('b'));
    expect(result.current.current).toBe('b');
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo restores previous state', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.pushState('b'));
    act(() => result.current.undo());
    expect(result.current.current).toBe('a');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('redo restores undone state', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.pushState('b'));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.current).toBe('b');
    expect(result.current.canRedo).toBe(false);
  });

  it('push after undo clears redo history', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.pushState('b'));
    act(() => result.current.pushState('c'));
    act(() => result.current.undo());
    expect(result.current.current).toBe('b');
    act(() => result.current.pushState('d'));
    expect(result.current.current).toBe('d');
    expect(result.current.canRedo).toBe(false);
  });

  it('set updates present without creating history', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.set('b'));
    expect(result.current.current).toBe('b');
    expect(result.current.canUndo).toBe(false);
  });

  it('skips duplicate pushes for primitive values', () => {
    const { result } = renderHook(() => useUndoRedo('hello'));
    act(() => result.current.pushState('hello'));
    expect(result.current.canUndo).toBe(false);
  });

  it('does not deduplicate object values (only reference equality is checked)', () => {
    const { result } = renderHook(() => useUndoRedo({ x: 1 }));
    // Pushing a new object with the same shape creates a new reference — treated as a new state
    act(() => result.current.pushState({ x: 1 }));
    expect(result.current.canUndo).toBe(true);
  });

  it('reset clears all history', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.pushState('b'));
    act(() => result.current.pushState('c'));
    act(() => result.current.reset('fresh'));
    expect(result.current.current).toBe('fresh');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo with no history is a no-op', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.undo());
    expect(result.current.current).toBe('a');
  });

  it('redo with no future is a no-op', () => {
    const { result } = renderHook(() => useUndoRedo('a'));
    act(() => result.current.redo());
    expect(result.current.current).toBe('a');
  });
});
