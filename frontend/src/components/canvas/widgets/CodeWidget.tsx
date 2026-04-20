import { CodeEditor } from '../CodeEditor';
import type { WidgetProps } from './types';

export function CodeWidget({
  value,
  onChange,
  schema,
  fieldName,
  disabled,
}: WidgetProps) {
  const displayValue =
    value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  const fmt = schema.format;
  const editorContext =
    fmt === 'json'
      ? 'json'
      : fmt === 'template'
        ? 'template'
        : fieldName === 'condition' || fieldName === 'expression'
          ? 'condition'
          : 'code';

  return (
    <>
      <CodeEditor
        value={String(displayValue)}
        editorMode={editorContext}
        readOnly={disabled}
        onChange={(raw) => {
          if (disabled) return;
          if (raw.startsWith('[') || raw.startsWith('{')) {
            try {
              onChange(JSON.parse(raw));
              return;
            } catch {}
          }
          onChange(raw || undefined);
        }}
        minHeight={fieldName === 'code' ? '160px' : fmt === 'template' ? '120px' : '80px'}
      />
      {fmt === 'json' && typeof value === 'string' && value.trim() && (() => {
        try { JSON.parse(value); return null; } catch (e) {
          return <p className="text-[10px] text-red-500 mt-1">Invalid JSON: {(e as Error).message}</p>;
        }
      })()}
    </>
  );
}
