import type { WidgetProps } from './types';

export function SliderWidget({ value, onChange, schema, disabled }: WidgetProps<number | undefined>) {
  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? 100;
  const step = schema.multipleOf ?? 1;
  const current = value != null ? Number(value) : min;
  const disabledCls = disabled ? ' opacity-60 cursor-default' : '';

  return (
    <div className={`flex items-center gap-2${disabledCls}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => { if (!disabled) onChange(Number(e.target.value)); }}
        disabled={disabled}
        className="flex-1 accent-blue-500"
      />
      <span className="text-xs text-text-secondary font-mono w-10 text-right">{current}</span>
    </div>
  );
}
