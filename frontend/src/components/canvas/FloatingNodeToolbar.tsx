import { memo, useCallback } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import { Copy, Trash2, Pencil } from 'lucide-react';

interface FloatingNodeToolbarProps {
  nodeId: string;
  selected: boolean;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onEdit?: (id: string) => void;
}

export const FloatingNodeToolbar = memo(function FloatingNodeToolbar({
  nodeId,
  selected,
  onDelete,
  onDuplicate,
  onEdit,
}: FloatingNodeToolbarProps) {
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.(nodeId);
  }, [nodeId, onDelete]);

  const handleDuplicate = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDuplicate?.(nodeId);
  }, [nodeId, onDuplicate]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.(nodeId);
  }, [nodeId, onEdit]);

  return (
    <NodeToolbar
      isVisible={selected}
      position={Position.Top}
      offset={8}
      className="nodrag nopan"
    >
      <div className="flex items-center gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-1 shadow-lg backdrop-blur-sm">
        <ToolbarButton icon={Pencil} label="Edit" onClick={handleEdit} />
        <ToolbarButton icon={Copy} label="Duplicate" onClick={handleDuplicate} />
        <div className="w-px h-5 bg-[var(--color-border)] mx-0.5" />
        <ToolbarButton icon={Trash2} label="Delete" onClick={handleDelete} variant="danger" />
      </div>
    </NodeToolbar>
  );
});

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  variant?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`
        w-8 h-8 rounded-lg flex items-center justify-center
        transition-colors duration-150
        ${variant === 'danger'
          ? 'text-[var(--color-text-tertiary)] hover:text-red-400 hover:bg-red-500/10'
          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-interactive)]'
        }
      `}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
