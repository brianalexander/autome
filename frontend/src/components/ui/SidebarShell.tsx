import { useState } from 'react';
import { ChevronLeft, Copy, Check } from 'lucide-react';
import { StatusBadge } from './StatusBadge';

export function SidebarShell({
  title,
  subtitle,
  statusBadge,
  onClose,
  onCopyConfig,
  children,
}: {
  title: string;
  subtitle?: string;
  statusBadge?: string;
  onClose: () => void;
  onCopyConfig?: () => void;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopyConfig?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      <div className="p-4 border-b border-border flex-shrink-0">
        {/* Title row: back nav + title + status badge + optional copy button */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
          >
            <ChevronLeft className="w-3 h-3" />
            Overview
          </button>
          <h3 className="font-semibold text-sm truncate">{title}</h3>
          {statusBadge && <StatusBadge status={statusBadge} />}
          {onCopyConfig && (
            <button
              onClick={handleCopy}
              className="ml-auto flex-shrink-0 text-text-tertiary hover:text-text-primary transition-colors p-1"
              title="Copy config as JSON"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>

        {subtitle && <p className="text-[10px] text-text-tertiary mt-1">{subtitle}</p>}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
    </div>
  );
}
