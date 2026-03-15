/**
 * ResizablePanel — A panel that can be resized by dragging its edge.
 * Works for both left-side (drag right edge) and right-side (drag left edge) panels.
 */
import { useState, useRef, useCallback, useEffect } from 'react';

interface ResizablePanelProps {
  /** Which side the panel is on — determines where the drag handle appears */
  side: 'left' | 'right';
  /** Default width in pixels */
  defaultWidth?: number;
  /** Minimum width in pixels */
  minWidth?: number;
  /** Maximum width in pixels */
  maxWidth?: number;
  /** Additional CSS classes for the outer container */
  className?: string;
  children: React.ReactNode;
}

export function ResizablePanel({
  side,
  defaultWidth = 384,
  minWidth = 280,
  maxWidth = 700,
  className = '',
  children,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = side === 'left' ? startWidthRef.current + delta : startWidthRef.current - delta;
      setWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [side, minWidth, maxWidth]);

  return (
    <div ref={panelRef} className={`relative flex-shrink-0 ${className}`} style={{ width }}>
      {children}

      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`absolute top-0 bottom-0 w-1 cursor-col-resize z-20 hover:bg-blue-500/50 active:bg-blue-500/70 transition-colors ${
          side === 'left' ? 'right-0' : 'left-0'
        }`}
      />
    </div>
  );
}
