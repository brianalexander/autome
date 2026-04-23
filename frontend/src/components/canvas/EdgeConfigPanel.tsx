import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import { useNodeTypes } from '../../hooks/queries';
import {
  type EdgeDefinition,
  type WorkflowDefinition,
} from '../../lib/api';
import { SchemaForm } from './SchemaForm';
import { CodeEditor } from './CodeEditor';
import { Field, SchemaPropertiesTree } from './ConfigPanelShared';
import { resolveEffectiveOutputSchema } from '../../lib/resolveOutputSchema';

/** Extract field references from a JS expression like output.foo.bar */
function extractFieldReferences(expr: string): string[][] {
  const paths: string[][] = [];
  const regex = /output\.(\w+(?:\.\w+)*)/g;
  let match;
  while ((match = regex.exec(expr)) !== null) {
    paths.push(match[1].split('.'));
  }
  return paths;
}

/** Check if a field path exists in a JSON Schema */
function validateFieldPath(schema: Record<string, unknown>, path: string[]): boolean {
  let current = schema;
  for (const key of path) {
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !props[key]) return false;
    current = props[key];
  }
  return true;
}

export interface EdgeConfigPanelProps {
  edge: EdgeDefinition;
  definition: WorkflowDefinition;
  isCycleEdge?: boolean;
  onSave: (updated: EdgeDefinition) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function EdgeConfigPanel({ edge, definition, isCycleEdge, onSave, onDelete, onClose }: EdgeConfigPanelProps) {
  const { data: specs } = useNodeTypes();

  // Local edit state — updated immediately for responsive typing.
  // Only reset when a DIFFERENT edge is selected.
  const [editState, setEditState] = useState<EdgeDefinition>(edge);
  useEffect(() => {
    setEditState(edge);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge.id]);

  const edgeSaveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingEdgeRef = useRef<EdgeDefinition>(editState);
  const debouncedFlush = useCallback(() => {
    if (edgeSaveTimeoutRef.current) clearTimeout(edgeSaveTimeoutRef.current);
    edgeSaveTimeoutRef.current = setTimeout(() => onSave(pendingEdgeRef.current), 300);
  }, [onSave]);

  const updateEdge = useCallback((updated: EdgeDefinition) => {
    pendingEdgeRef.current = updated;
    setEditState(updated);
    debouncedFlush();
  }, [debouncedFlush]);

  useEffect(() => () => {
    if (edgeSaveTimeoutRef.current) clearTimeout(edgeSaveTimeoutRef.current);
  }, []);

  // Look up source/target node type specs for edge schema
  const sourceStage = definition.stages.find((s) => s.id === edge.source);
  const targetStage = definition.stages.find((s) => s.id === edge.target);
  const sourceSpec = specs?.find((s) => s.id === sourceStage?.type);
  const targetSpec = specs?.find((s) => s.id === targetStage?.type);

  // Resolved source output schema — substitutes x-passthrough fields so gate/review-gate
  // nodes show downstream-relevant typed schemas instead of untyped placeholders.
  const sourceOutputSchema = useMemo(
    () => (sourceStage ? resolveEffectiveOutputSchema(sourceStage.id, definition, specs ?? undefined) : undefined),
    [sourceStage, definition, specs],
  );

  return (
    <div className="w-full h-full bg-surface flex flex-col min-h-0 overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between flex-shrink-0">
        <h3 className="font-semibold text-sm">Configure Edge</h3>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors p-1" title="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        <Field label="Edge ID">
          <input value={editState.id} disabled className="input-field opacity-60" />
        </Field>

        <Field label="Connection">
          <div className="text-sm text-text-primary font-mono">
            {editState.source} → {editState.target}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            {sourceSpec?.name || sourceStage?.type} → {targetSpec?.name || targetStage?.type}
          </div>
        </Field>

        {/* Source output schema reference — shows what fields are available */}
        {!!sourceOutputSchema?.properties && (
          <div className="bg-surface-secondary/50 border border-border-subtle rounded-lg p-3">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-2">
              Available from {sourceStage?.label || editState.source}
            </div>
            <SchemaPropertiesTree
              properties={sourceOutputSchema.properties as Record<string, Record<string, unknown>>}
              depth={0}
              prefix="output"
            />
          </div>
        )}

        <Field label="Label">
          <input
            value={editState.label || ''}
            onChange={(e) => updateEdge({ ...editState, label: e.target.value || undefined })}
            className="input-field"
            placeholder="e.g., Approved, Needs revision"
          />
        </Field>

        <Field label="Trigger">
          <select
            value={editState.trigger || 'on_success'}
            onChange={(e) =>
              updateEdge({
                ...editState,
                trigger: e.target.value === 'on_success' ? undefined : (e.target.value as 'on_error'),
              })
            }
            className="input-field"
          >
            <option value="on_success">On Success (default)</option>
            <option value="on_error">On Error (fallback path)</option>
          </select>
          {editState.trigger === 'on_error' && (
            <div className="text-[10px] text-orange-600 dark:text-orange-400 mt-0.5">
              This edge fires when the source stage fails after exhausting retries. The target receives{' '}
              {'{ error, stageId, lastOutput }'} as input.
            </div>
          )}
        </Field>

        {/* Source node's outEdgeSchema */}
        {sourceSpec?.outEdgeSchema && (
          <div className="border-t border-border pt-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">From: {sourceSpec.name}</div>
            <SchemaForm
              schema={sourceSpec.outEdgeSchema}
              value={editState as Record<string, unknown>}
              onChange={(updated) => updateEdge({ ...editState, ...updated })}
              outputSchema={sourceOutputSchema}
            />
          </div>
        )}

        {/* Target node's inEdgeSchema */}
        {targetSpec?.inEdgeSchema && (
          <div className="border-t border-border pt-4">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-3">To: {targetSpec.name}</div>
            <SchemaForm
              schema={targetSpec.inEdgeSchema}
              value={editState as Record<string, unknown>}
              onChange={(updated) => updateEdge({ ...editState, ...updated })}
              outputSchema={sourceOutputSchema}
            />
          </div>
        )}

        {/* Fallback: if neither node declares edge schemas, show basic fields */}
        <>
          {!sourceSpec?.outEdgeSchema && !targetSpec?.inEdgeSchema && (
            <Field label="Condition (JS expression)">
              <CodeEditor
                value={editState.condition || ''}
                onChange={(val) => updateEdge({ ...editState, condition: val || undefined })}
                editorMode="condition"
                minHeight="60px"
                outputSchema={sourceOutputSchema}
              />
            </Field>
          )}

          {/* Design-time validation warnings */}
          {(() => {
            const conditionExpr = editState.condition;
            if (!sourceOutputSchema?.properties || !conditionExpr) return null;

            const refs = extractFieldReferences(conditionExpr);
            const invalid = refs.filter((path) => !validateFieldPath(sourceOutputSchema, path));
            if (invalid.length === 0) return null;

            return (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-700/50 rounded-lg p-2.5 text-xs">
                <div className="text-amber-700 dark:text-amber-300 font-medium mb-1">Schema warning</div>
                {invalid.map((path, i) => (
                  <div key={i} className="text-amber-600 dark:text-amber-400">
                    <code className="font-mono">output.{path.join('.')}</code> not found in source schema
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      </div>
    </div>
  );
}
