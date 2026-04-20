import type { WidgetProps } from './types';

export function ColorWidget({ value, onChange, disabled }: WidgetProps<string | undefined>) {
  const hex = typeof value === 'string' ? value : '#000000';
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';

  return (
    <div className={`flex items-center gap-2${disabledCls}`}>
      <input
        type="color"
        value={hex}
        onChange={(e) => { if (!disabled) onChange(e.target.value); }}
        disabled={disabled}
        className="w-8 h-8 rounded border border-border cursor-pointer p-0.5 bg-surface-secondary"
      />
      <input
        type="text"
        value={hex}
        onChange={(e) => { if (!disabled) onChange(e.target.value); }}
        disabled={disabled}
        placeholder="#000000"
        maxLength={7}
        className={`flex-1 bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono${disabledCls}`}
      />
    </div>
  );
}
