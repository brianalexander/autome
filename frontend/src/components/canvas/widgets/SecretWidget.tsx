import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { WidgetProps } from './types';

export function SecretWidget({ value, onChange, disabled }: WidgetProps<string | undefined>) {
  const [show, setShow] = useState(false);
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
        className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 pr-8 text-sm text-text-primary font-mono${disabledCls}`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        disabled={disabled}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
        aria-label={show ? 'Hide' : 'Show'}
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
