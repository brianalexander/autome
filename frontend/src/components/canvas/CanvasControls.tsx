import { memo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ZoomIn, ZoomOut, Maximize, LayoutGrid, Keyboard } from 'lucide-react';

interface CanvasControlsProps {
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onRelayout?: () => void;
  onShortcutsHelp?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  isAuthor?: boolean;
}

export const CanvasControls = memo(function CanvasControls({
  onUndo,
  onRedo,
  onSave,
  onRelayout,
  onShortcutsHelp,
  canUndo,
  canRedo,
  saveDisabled,
  saveLabel = 'Save',
  isAuthor,
}: CanvasControlsProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="absolute bottom-3 left-3 z-40 flex items-center gap-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-lg backdrop-blur-sm px-1.5 py-1">
      {/* Zoom controls */}
      <ControlButton icon={ZoomOut} label="Zoom out" onClick={() => zoomOut()} />
      <ControlButton icon={ZoomIn} label="Zoom in" onClick={() => zoomIn()} />
      <ControlButton icon={Maximize} label="Fit view" onClick={() => fitView({ padding: 0.3, maxZoom: 1.5 })} />

      {/* Separator — only when author content follows */}
      {isAuthor && <div className="w-px h-5 bg-[var(--color-border)] mx-0.5" />}

      {/* Re-layout — author mode only */}
      {isAuthor && onRelayout && (
        <>
          <ControlButton icon={LayoutGrid} label="Re-layout" onClick={onRelayout} />
          <div className="w-px h-5 bg-[var(--color-border)] mx-0.5" />
        </>
      )}

      {/* Undo/Redo — author mode only */}
      {isAuthor && (
        <>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="px-2 py-1 text-xs rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)] disabled:opacity-30 transition-colors"
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="px-2 py-1 text-xs rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)] disabled:opacity-30 transition-colors"
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
          <div className="w-px h-5 bg-[var(--color-border)] mx-0.5" />
        </>
      )}

      {/* Shortcuts help */}
      {onShortcutsHelp && (
        <ControlButton icon={Keyboard} label="Keyboard shortcuts (?)" onClick={onShortcutsHelp} />
      )}

      {/* Save — author mode only */}
      {isAuthor && onSave && (
        <>
          <div className="w-px h-5 bg-[var(--color-border)] mx-0.5" />
          <button
            onClick={onSave}
            disabled={saveDisabled}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition-colors"
          >
            {saveLabel}
          </button>
        </>
      )}
    </div>
  );
});

function ControlButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)] transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
