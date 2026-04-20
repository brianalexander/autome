import { useState } from 'react';
import { X } from 'lucide-react';
import type { WidgetProps } from './types';

/** Chip input — Enter to add, Backspace on empty removes last, x on chip removes it. */
export function TagsWidget({ value, onChange, disabled }: WidgetProps<string[] | undefined>) {
  const tags = Array.isArray(value) ? value : [];
  const [input, setInput] = useState('');

  const addTag = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput('');
  };

  const removeTag = (index: number) => {
    if (disabled) return;
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  return (
    <div className={`flex flex-wrap gap-1 border border-border rounded px-2 py-1.5 bg-surface-secondary min-h-[34px]${disabled ? ' opacity-60' : ''}`}>
      {tags.map((tag, i) => (
        <span key={i} className="inline-flex items-center gap-1 bg-surface border border-border rounded px-1.5 py-0.5 text-xs text-text-primary">
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeTag(i)}
              className="text-text-tertiary hover:text-text-primary"
              aria-label={`Remove ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (input.trim()) addTag(input); }}
          placeholder={tags.length === 0 ? 'Type and press Enter…' : ''}
          className="flex-1 min-w-[80px] bg-transparent text-sm text-text-primary outline-none"
        />
      )}
    </div>
  );
}
