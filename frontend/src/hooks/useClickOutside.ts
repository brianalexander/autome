import { useEffect, type RefObject } from 'react';

export function useClickOutside(ref: RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      // composedPath() includes shadow DOM and portal elements that .contains()
      // would miss, preventing false dismissals when clicking inside portals
      // (dropdowns, modals) that render outside the ref's DOM subtree.
      if (ref.current && !e.composedPath().includes(ref.current)) {
        handler();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [ref, handler]);
}
