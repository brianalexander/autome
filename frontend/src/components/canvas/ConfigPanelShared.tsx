import type { ReactNode } from 'react';

/** Labelled form field wrapper used across ConfigPanel, EdgeConfigPanel, and AgentConfigSection. */
export function Field({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      {children}
      {description && <p className="text-[10px] text-text-tertiary mt-1">{description}</p>}
    </div>
  );
}
