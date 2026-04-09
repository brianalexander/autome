/**
 * CodeEditor — CodeMirror-based editor with syntax highlighting, autocompletion,
 * and an expand-to-modal feature for comfortable code editing.
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { githubDark } from '@uiw/codemirror-theme-github';
import { autocompletion, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { jinja, closePercentBrace } from '@codemirror/lang-jinja';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import { Maximize2, Minimize2 } from 'lucide-react';

// --- Autocompletion definitions ---

const TOP_LEVEL_COMPLETIONS: Completion[] = [
  { label: 'input', type: 'variable', detail: 'Record<stageId, output>', info: 'Upstream outputs keyed by source stage ID. Access via input.stage_name or Object.values(input)[0]' },
  { label: 'config', type: 'variable', detail: '{ code, timeout_seconds, ... }', info: 'This node\'s configuration values' },
  { label: 'console', type: 'variable', detail: '{ log, warn, error }', info: 'Logging (no-op in sandbox)' },
  { label: 'JSON', type: 'variable', detail: 'JSON', info: 'JSON.parse() and JSON.stringify()' },
  { label: 'Math', type: 'variable', detail: 'Math', info: 'Math.round(), Math.max(), etc.' },
  { label: 'Date', type: 'class', detail: 'DateConstructor', info: 'new Date(), Date.now()' },
];

// MEMBER_MAP is intentionally empty — input members are handled by schema-aware completions
const MEMBER_MAP: Record<string, Array<{ label: string; detail: string; info: string }>> = {};

// --- Hover tooltip data ---

interface HoverInfo {
  type: string;
  description: string;
}

const HOVER_MAP: Record<string, HoverInfo> = {
  // Top-level identifiers
  input: { type: 'Record<stageId, output>', description: 'Upstream outputs keyed by source stage ID. Access via input.stage_name or Object.values(input)[0]' },
  config: { type: '{ code, timeout_seconds, ... }', description: "This node's configuration values" },
  console: { type: '{ log, warn, error }', description: 'Console methods (no-op in sandbox)' },
  JSON: { type: 'JSON', description: 'JSON.parse() and JSON.stringify()' },
  Math: { type: 'Math', description: 'Math.round(), Math.max(), etc.' },
  Date: { type: 'DateConstructor', description: 'new Date(), Date.now()' },
};

const codeHoverTooltip = hoverTooltip((view, pos): Tooltip | null => {
  // Get the word at the hover position
  const { from, text } = view.state.doc.lineAt(pos);
  const lineText = text;
  const col = pos - from;

  // Expand from cursor position to find the identifier (including dots for member access)
  let start = col;
  let end = col;
  while (start > 0 && /[\w.]/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /[\w]/.test(lineText[end])) end++;

  const word = lineText.slice(start, end);
  if (!word) return null;

  const info = HOVER_MAP[word];
  if (!info) return null;

  return {
    pos: from + start,
    end: from + end,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-hover-tooltip';
      dom.style.cssText = 'padding: 4px 8px; font-size: 11px; font-family: ui-monospace, monospace; max-width: 350px;';

      const typeEl = document.createElement('div');
      typeEl.style.cssText = 'color: #7dd3fc; font-weight: 600; margin-bottom: 2px;';
      typeEl.textContent = word + ': ' + info.type;
      dom.appendChild(typeEl);

      const descEl = document.createElement('div');
      descEl.style.cssText = 'color: #a1a1aa; font-size: 10px;';
      descEl.textContent = info.description;
      dom.appendChild(descEl);

      return { dom };
    },
  };
});

function codeExecutorCompletions(ctx: CompletionContext) {
  // Single-level member access on known objects
  const dotMatch = ctx.matchBefore(/(\w+)\.\w*/);
  if (dotMatch) {
    const objName = dotMatch.text.split('.')[0];
    const members = MEMBER_MAP[objName];
    if (members && members.length > 0) {
      const from = dotMatch.from + objName.length + 1;
      return {
        from,
        options: members.map((m) => ({
          label: m.label,
          type: 'property' as const,
          detail: m.detail,
          info: m.info,
        })),
      };
    }
    return null;
  }

  // Top-level completions
  const word = ctx.matchBefore(/\w+/);
  if (!word && !ctx.explicit) return null;
  return {
    from: word?.from ?? ctx.pos,
    options: TOP_LEVEL_COMPLETIONS,
  };
}

// --- Schema-driven autocompletion helpers ---

/** Walk a JSON Schema's properties and generate completion entries */
function schemaToCompletions(schema: Record<string, unknown>, _prefix: string): Completion[] {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return [];
  return Object.entries(props).map(([key, propSchema]) => ({
    label: key,
    type: 'property' as const,
    detail: (propSchema.type as string) || 'unknown',
    info: (propSchema.description as string) || '',
    boost: 1, // Prioritize schema completions over generic ones
  }));
}

/** Walk into a nested JSON Schema path and return the sub-schema */
function walkSchema(schema: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current = schema;
  for (const key of path) {
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !props[key]) return null;
    current = props[key];
  }
  return current;
}

function createSchemaAwareCompletions(outputSchema?: Record<string, unknown>) {
  return function schemaAwareCompletions(ctx: CompletionContext) {
    if (outputSchema) {
      // Handle input.X — the upstream stage's output fields
      // This covers both:
      //   - function(input) { input.field }  (single param = upstream data)
      //   - function({ input }) { input.field }  (destructured = upstream data)
      const inputDotChain = ctx.matchBefore(/input(\.\w+)*\.\w*/);
      if (inputDotChain) {
        const parts = inputDotChain.text.split('.');
        // Remove 'input' prefix, keep intermediate path parts, drop partial last
        const pathParts = parts.slice(1, -1);
        const subSchema = pathParts.length > 0 ? walkSchema(outputSchema, pathParts) : outputSchema;
        if (subSchema) {
          const lastDot = inputDotChain.text.lastIndexOf('.');
          return {
            from: inputDotChain.from + lastDot + 1,
            options: schemaToCompletions(subSchema, ''),
          };
        }
      }

      // Handle output.X — used in edge conditions
      const outputDotChain = ctx.matchBefore(/output(\.\w+)*\.\w*/);
      if (outputDotChain) {
        const parts = outputDotChain.text.split('.');
        const pathParts = parts.slice(1, -1);
        const subSchema = pathParts.length > 0 ? walkSchema(outputSchema, pathParts) : outputSchema;
        if (subSchema) {
          const lastDot = outputDotChain.text.lastIndexOf('.');
          return {
            from: outputDotChain.from + lastDot + 1,
            options: schemaToCompletions(subSchema, ''),
          };
        }
      }
    }

    return codeExecutorCompletions(ctx);
  };
}

// --- Template mode: Jinja2-aware autocomplete and linting ---

function createJinjaConfig(outputSchema?: Record<string, unknown>) {
  return {
    variables: [{ label: 'output', type: 'variable' as const, detail: 'source stage output', info: 'Access fields via output.field_name' }] as readonly Completion[],
    properties(path: readonly string[]): readonly Completion[] {
      if (!outputSchema) return [];

      if (path.length === 0) {
        // Top level — suggest 'output'
        return [{ label: 'output', type: 'variable' as const }];
      }

      if (path[0] !== 'output') return [];

      // Walk the schema for the remaining path
      let schema = outputSchema;
      for (let i = 1; i < path.length; i++) {
        const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
        if (!props || !props[path[i]]) return [];
        schema = props[path[i]];
        // Handle array items
        if (schema.type === 'array' && schema.items) {
          schema = schema.items as Record<string, unknown>;
        }
      }

      // Return property names at this level
      const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props) return [];
      return Object.keys(props).map((key) => ({
        label: key,
        type: 'property' as const,
        detail: (props[key].type as string) || 'unknown',
        info: (props[key].description as string) || '',
      }));
    },
  };
}

/** Duplicate of EdgeConfigPanel's validateFieldPath — walks a JSON Schema to check a field path exists */
function validateFieldPath(schema: Record<string, unknown>, path: string[]): boolean {
  let current = schema;
  for (const key of path) {
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !props[key]) return false;
    current = props[key];
  }
  return true;
}

function createTemplateLinter(outputSchema?: Record<string, unknown>) {
  return linter(async (view): Promise<Diagnostic[]> => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];
    const diagnostics: Diagnostic[] = [];

    // 1. Backend syntax validation
    try {
      const res = await fetch('/api/internal/validate-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: text }),
      });
      if (res.ok) {
        const { diagnostics: syntaxDiags } = await res.json() as { diagnostics: Array<{ from: number; to: number; severity: string; message: string }> };
        const docLength = view.state.doc.length;
        for (const d of syntaxDiags) {
          if (d.from >= 0 && d.to <= docLength && d.from < d.to) {
            diagnostics.push({
              from: d.from,
              to: d.to,
              severity: d.severity as 'error' | 'warning',
              message: d.message,
            });
          }
        }
      }
    } catch {
      // Network error — skip syntax validation
    }

    // 2. Field path validation (only if schema available)
    if (outputSchema?.properties) {
      const pattern = /\{\{\s*output\.(\w+(?:\.\w+)*)\s*(?:\|[^}]*)?\}\}/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const fieldPath = match[1].split('.');
        if (!validateFieldPath(outputSchema, fieldPath)) {
          const from = match.index + match[0].indexOf('output.');
          const to = from + 'output.'.length + match[1].length;
          diagnostics.push({
            from,
            to,
            severity: 'warning',
            message: `Field "output.${match[1]}" not found in source output schema`,
          });
        }
      }
    }

    return diagnostics;
  }, { delay: 500 });
}

// --- Placeholder ---

const PLACEHOLDER_CONDITION = `output.status === 'approved' && output.score > 0.8`;

const PLACEHOLDER_JSON = `{
  "key": "value"
}`;

const PLACEHOLDER_TEMPLATE = `You are a specialist. Here is your task:

{{ output.description }}

{% if output.requirements %}
Requirements:
{% for req in output.requirements %}- {{ req }}
{% endfor %}{% endif %}`;

const PLACEHOLDER_CODE = `export default ({ input }) => {
  // input — upstream outputs keyed by stage ID
  // e.g. input.my_stage.field_name
  // For single-input: Object.values(input)[0]

  const data = Object.values(input)[0];
  return {
    processed: data,
  };
};`;

// --- Backend TypeScript linting ---

function createCodeLinter(
  outputSchema?: Record<string, unknown>,
  nodeType?: string,
  validationMode?: 'function' | 'expression',
  returnSchema?: Record<string, unknown>,
) {
  return linter(async (view): Promise<Diagnostic[]> => {
    const code = view.state.doc.toString();
    if (!code.trim()) return [];

    try {
      const res = await fetch('/api/internal/validate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, outputSchema, nodeType, validationMode: validationMode || 'function', returnSchema }),
      });
      if (!res.ok) return [];
      const { diagnostics } = await res.json() as { diagnostics: Array<{ from: number; to: number; severity: string; message: string }> };

      const docLength = view.state.doc.length;
      return diagnostics
        .filter(d => d.from >= 0 && d.to <= docLength && d.from < d.to)
        .map(d => ({
          from: d.from,
          to: d.to,
          severity: d.severity as 'error' | 'warning' | 'info',
          message: d.message,
        }));
    } catch {
      return []; // Network error — silently skip
    }
  }, { delay: 250 });
}

// --- CSS fix: make editor fill its container even when empty ---

function editorFillTheme(minH: string) {
  return EditorView.theme({
    '&': { width: '100%', minHeight: minH },
    '.cm-scroller': { overflow: 'auto', minHeight: minH },
    '.cm-content': { minHeight: minH },
    '.cm-gutters': { minHeight: minH },
    '&.cm-focused': { outline: 'none' },
  });
}

// --- Component ---

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  /** Mode hint for choosing the right placeholder and language */
  editorMode?: 'code' | 'condition' | 'json' | 'template';
  /** JSON Schema of the upstream node's output — used for autocomplete suggestions */
  outputSchema?: Record<string, unknown>;
  /** Node type hint for the backend validation (e.g. 'code-executor', 'code-trigger') */
  nodeType?: string;
  /** The node's OWN output schema — validates the function's return type */
  returnSchema?: Record<string, unknown>;
}

export function CodeEditor({
  value,
  onChange,
  placeholder,
  minHeight = '120px',
  editorMode = 'code',
  outputSchema,
  nodeType,
  returnSchema,
}: CodeEditorProps) {
  const [expanded, setExpanded] = useState(false);

  const outputSchemaKey = JSON.stringify(outputSchema);
  const returnSchemaKey = JSON.stringify(returnSchema);

  const completionFn = useMemo(
    () => createSchemaAwareCompletions(outputSchema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputSchemaKey],
  );

  const jinjaConfig = useMemo(
    () => createJinjaConfig(outputSchema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputSchemaKey],
  );

  const templateLinter = useMemo(
    () => createTemplateLinter(outputSchema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputSchemaKey],
  );

  const codeLinter = useMemo(
    () => {
      if (editorMode === 'code') return createCodeLinter(outputSchema, nodeType, 'function', returnSchema);
      if (editorMode === 'condition') return createCodeLinter(outputSchema, undefined, 'expression');
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorMode, outputSchemaKey, nodeType, returnSchemaKey],
  );

  const fillTheme = useMemo(() => editorFillTheme(expanded ? '60vh' : minHeight), [expanded, minHeight]);

  const extensions = useMemo(
    () => {
      if (editorMode === 'template') {
        return [
          jinja(jinjaConfig),
          closePercentBrace,
          autocompletion({ activateOnTyping: true }),
          ...(templateLinter ? [templateLinter, lintGutter()] : []),
          fillTheme,
        ];
      }
      return [
        editorMode === 'json' ? json() : javascript({ jsx: false, typescript: true }),
        ...(editorMode !== 'json'
          ? [
              autocompletion({
                override: [completionFn],
                activateOnTyping: true,
              }),
              codeHoverTooltip,
            ]
          : []),
        ...(codeLinter ? [codeLinter, lintGutter()] : []),
        fillTheme,
      ];
    },
    [editorMode, completionFn, jinjaConfig, templateLinter, codeLinter, fillTheme],
  );

  // Close on Escape and stop propagation so ConfigPanel doesn't also close
  const handleExpandKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && expanded) {
      e.stopPropagation();
      e.preventDefault();
      setExpanded(false);
    }
  }, [expanded]);

  useEffect(() => {
    if (expanded) {
      document.addEventListener('keydown', handleExpandKeyDown, true); // capture phase
      return () => document.removeEventListener('keydown', handleExpandKeyDown, true);
    }
  }, [expanded, handleExpandKeyDown]);

  return (
    <div className="relative group w-full">
      {/* Backdrop when expanded */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setExpanded(false)} />
      )}

      {/* Editor container — always in the same DOM position */}
      <div className={expanded
        ? "fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none"
        : ""
      }>
        <div className={expanded
          ? "bg-surface border border-border rounded-xl w-[90vw] max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl pointer-events-auto"
          : ""
        }>
          {/* Modal header — only when expanded */}
          {expanded && (
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="font-mono font-medium">Code Editor</span>
                <span className="text-text-tertiary">{editorMode === 'json' ? 'JSON' : editorMode === 'template' ? 'Jinja2 Template' : 'JavaScript'}</span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-surface-secondary"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                Collapse
              </button>
            </div>
          )}

          {/* Editor body — always rendered, same instance */}
          <div className={expanded ? "flex-1 overflow-auto p-3" : ""}>
            <CodeMirror
              value={value}
              onChange={onChange}
              extensions={extensions}
              theme={githubDark}
              placeholder={placeholder || (editorMode === 'json' ? PLACEHOLDER_JSON : editorMode === 'condition' ? PLACEHOLDER_CONDITION : editorMode === 'template' ? PLACEHOLDER_TEMPLATE : PLACEHOLDER_CODE)}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightSelectionMatches: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: false,
                indentOnInput: true,
              }}
              style={{ fontSize: '12px', width: '100%' }}
              className="overflow-hidden rounded border border-border"
            />
          </div>
        </div>
      </div>

      {/* Expand button — only when not expanded */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-surface-secondary/90 border border-border rounded p-1 text-text-tertiary hover:text-text-primary"
          title="Expand editor"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
