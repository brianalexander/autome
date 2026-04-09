import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyDropdownProps {
  copyState: 'idle' | 'text' | 'full';
  hasTools: boolean;
  onCopyText: () => void;
  onCopyFull: () => void;
}

export function CopyDropdown({
  copyState,
  onCopyFull,
}: CopyDropdownProps) {
  if (copyState !== 'idle') {
    return <span className="text-[10px] text-green-400 px-1">Copied!</span>;
  }

  return (
    <button
      onClick={onCopyFull}
      className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-surface-secondary/50"
      title="Copy"
    >
      <Copy size={12} />
    </button>
  );
}
