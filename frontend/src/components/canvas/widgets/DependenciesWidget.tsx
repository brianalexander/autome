import { useState, useEffect } from 'react';
import type { WidgetProps } from './types';

export function DependenciesWidget({ value, onChange, disabled }: WidgetProps<Record<string, string> | undefined>) {
  const deps = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string>;
  const serialized = Object.entries(deps)
    .map(([pkg, ver]) => (ver && ver !== 'latest' ? `${pkg}@${ver}` : pkg))
    .join('\n');

  const [text, setText] = useState(serialized);
  const [focused, setFocused] = useState(false);

  // Sync from parent when not focused (external changes)
  useEffect(() => {
    if (!focused) setText(serialized);
  }, [serialized, focused]);

  const commitValue = (raw: string) => {
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const atIdx = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);
      if (atIdx > 0) {
        parsed[trimmed.slice(0, atIdx)] = trimmed.slice(atIdx + 1);
      } else {
        parsed[trimmed] = 'latest';
      }
    }
    onChange(Object.keys(parsed).length > 0 ? parsed : undefined);
  };

  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        if (!disabled) commitValue(e.target.value);
      }}
      rows={2}
      disabled={disabled}
      className={`w-full bg-surface-secondary border border-border rounded px-2 py-1.5 text-sm text-text-primary font-mono resize-y${disabled ? ' opacity-60 cursor-default' : ''}`}
      spellCheck={false}
      placeholder={"lodash@^4.17.21\naxios@^1.7.0"}
    />
  );
}
