import type { ReactNode } from 'react';

/** Labelled form field wrapper used across ConfigPanel, EdgeConfigPanel, and AgentConfigSection. */
export function Field({ label, description, required, children }: { label: string; description?: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {description && <p className="text-[10px] text-text-tertiary mt-1">{description}</p>}
    </div>
  );
}

const MAX_SCHEMA_DEPTH = 4;

/**
 * Recursively render JSON Schema properties as a tree.
 * Used by ConfigPanel (input display) and EdgeConfigPanel (source output display).
 * @param prefix — when set, top-level keys render as `{prefix}.{key}` (e.g. "output.field"); otherwise `.{key}`
 */
export function SchemaPropertiesTree({ properties, depth, prefix }: {
  properties: Record<string, Record<string, unknown>>;
  depth: number;
  prefix?: string;
}) {
  if (depth > MAX_SCHEMA_DEPTH) return null;
  return (
    <div className="space-y-0.5" style={{ marginLeft: depth > 0 ? `${depth * 12}px` : undefined }}>
      {Object.entries(properties).map(([key, propSchema]) => {
        const propType = propSchema.type as string | undefined;
        const propDesc = propSchema.description as string | undefined;
        const nestedProps = propSchema.properties as Record<string, Record<string, unknown>> | undefined;
        const itemsSchema = propSchema.items as Record<string, unknown> | undefined;
        const itemProps = itemsSchema?.properties as Record<string, Record<string, unknown>> | undefined;
        const label = depth === 0 && prefix ? `${prefix}.${key}` : `.${key}`;

        return (
          <div key={key}>
            <div className="flex items-baseline gap-2 text-xs">
              <code className="text-blue-400 font-mono text-[10px]">{label}</code>
              {propType && <span className="text-text-muted text-[10px]">{propType}{itemProps ? '[]' : ''}</span>}
              {propDesc && <span className="text-text-tertiary text-[10px]">— {propDesc}</span>}
            </div>
            {nestedProps && <SchemaPropertiesTree properties={nestedProps} depth={depth + 1} />}
            {itemProps && <SchemaPropertiesTree properties={itemProps} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}
