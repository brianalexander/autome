/**
 * CodeEditor — CodeMirror-based editor with syntax highlighting, autocompletion,
 * and an expand-to-modal feature for comfortable code editing.
 */
import { useState, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { githubDark } from '@uiw/codemirror-theme-github';
import { autocompletion, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import { Maximize2, Minimize2 } from 'lucide-react';

// --- Autocompletion definitions ---

interface TypeMember {
  label: string;
  detail: string;
  info: string;
}

const CONTEXT_MEMBERS: TypeMember[] = [
  { label: 'trigger', detail: 'Event', info: 'The event that kicked off this workflow run' },
  { label: 'stages', detail: '{ [stageId]: StageContext }', info: 'Access any stage\'s output: context.stages["my-stage"].latest' },
  { label: 'variables', detail: '{ [key]: any }', info: 'Shared workflow variables, writable across stages' },
];

const TRIGGER_MEMBERS: TypeMember[] = [
  { label: 'type', detail: 'string', info: '"webhook" | "manual" | "schedule" — how the workflow was triggered' },
  { label: 'payload', detail: '{ [key]: any }', info: 'The raw event data (e.g. webhook body, form fields)' },
  { label: 'source', detail: 'string', info: 'Identifier of the event source (e.g. provider name)' },
  { label: 'timestamp', detail: 'ISO 8601 string', info: 'When the event was received' },
];

const STAGES_DEEP_MEMBERS: TypeMember[] = [
  { label: 'latest', detail: 'any', info: 'Most recent output of this stage' },
  { label: 'run_count', detail: 'number', info: 'How many times this stage has executed' },
  { label: 'status', detail: 'string', info: '"pending" | "running" | "completed" | "failed"' },
  { label: 'runs', detail: 'StageRun[]', info: 'Full history of all runs for this stage' },
];

const TOP_LEVEL_COMPLETIONS: Completion[] = [
  { label: 'input', type: 'variable', detail: 'upstream output', info: 'Output from the upstream stage. Access fields via input.fieldName' },
  { label: 'config', type: 'variable', detail: '{ code, timeout_seconds, ... }', info: 'This node\'s configuration values' },
  { label: 'context', type: 'variable', detail: '{ trigger, stages, variables }', info: 'Full workflow context. Access other stages via context.stages["id"].latest' },
  { label: 'trigger', type: 'variable', detail: '{ type, payload, source, timestamp }', info: 'Shorthand for context.trigger — the event that started this workflow' },
  { label: 'console', type: 'variable', detail: '{ log, warn, error }', info: 'Logging (no-op in sandbox)' },
  { label: 'JSON', type: 'variable', detail: 'JSON', info: 'JSON.parse() and JSON.stringify()' },
  { label: 'Math', type: 'variable', detail: 'Math', info: 'Math.round(), Math.max(), etc.' },
  { label: 'Date', type: 'class', detail: 'DateConstructor', info: 'new Date(), Date.now()' },
];

const MEMBER_MAP: Record<string, TypeMember[]> = {
  context: CONTEXT_MEMBERS,
  trigger: TRIGGER_MEMBERS,
};

// --- Hover tooltip data ---

interface HoverInfo {
  type: string;
  description: string;
}

const HOVER_MAP: Record<string, HoverInfo> = {
  // Top-level identifiers
  input: { type: 'upstream output', description: 'Output from the upstream stage — fields depend on the source node\'s output schema' },
  config: { type: '{ code, timeout_seconds, ... }', description: "This node's configuration values" },
  context: { type: '{ trigger, stages, variables }', description: 'Full workflow execution context' },
  trigger: { type: '{ type, payload, source, timestamp }', description: 'The event that started this workflow' },
  console: { type: '{ log, warn, error }', description: 'Console methods (no-op in sandbox)' },
  JSON: { type: 'JSON', description: 'JSON.parse() and JSON.stringify()' },
  Math: { type: 'Math', description: 'Math.round(), Math.max(), etc.' },
  Date: { type: 'DateConstructor', description: 'new Date(), Date.now()' },
};

// Build member hover entries: "trigger.payload", "context.stages", etc.
for (const [parent, members] of Object.entries(MEMBER_MAP)) {
  for (const m of members) {
    HOVER_MAP[`${parent}.${m.label}`] = { type: m.detail, description: m.info };
  }
}
// Deep members for context.stages
for (const m of STAGES_DEEP_MEMBERS) {
  HOVER_MAP[`stages.${m.label}`] = { type: m.detail, description: m.info };
}

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
  // Deep member access: context.stages["x"].
  const deepDot = ctx.matchBefore(/context\.stages\[.*?\]\.\w*/);
  if (deepDot) {
    const lastDot = deepDot.text.lastIndexOf('.');
    return {
      from: deepDot.from + lastDot + 1,
      options: STAGES_DEEP_MEMBERS.map((m) => ({
        label: m.label,
        type: 'property' as const,
        detail: m.detail,
        info: m.info,
      })),
    };
  }

  // Single-level member access: "context.", "trigger.", etc.
  const dotMatch = ctx.matchBefore(/(\w+)\.\w*/);
  if (dotMatch) {
    const objName = dotMatch.text.split('.')[0];
    const members = MEMBER_MAP[objName];
    if (members) {
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

// --- Placeholder ---

const PLACEHOLDER_CONDITION = `output.status === 'approved' && output.score > 0.8`;

const PLACEHOLDER_JSON = `{
  "key": "value"
}`;

const PLACEHOLDER_CODE = `import _ from 'lodash';

export default ({ input, config, context, trigger }) => {
  // input    — output from the upstream stage
  // config   — this node's configuration
  // context  — workflow context (.stages["id"].latest)
  // trigger  — the event that started this workflow

  const items = input.data || [];

  return {
    count: items.length,
    sorted: _.sortBy(items, 'name'),
  };
};`;

// --- Backend TypeScript linting ---

function createCodeLinter(outputSchema?: Record<string, unknown>, nodeType?: string) {
  return linter(async (view): Promise<Diagnostic[]> => {
    const code = view.state.doc.toString();
    if (!code.trim()) return [];

    try {
      const res = await fetch('/api/internal/validate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, outputSchema, nodeType }),
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
  editorMode?: 'code' | 'condition' | 'json';
  /** JSON Schema of the upstream node's output — used for autocomplete suggestions */
  outputSchema?: Record<string, unknown>;
  /** Node type hint for the backend validation (e.g. 'code-executor', 'code-trigger') */
  nodeType?: string;
}

export function CodeEditor({
  value,
  onChange,
  placeholder,
  minHeight = '120px',
  editorMode = 'code',
  outputSchema,
  nodeType,
}: CodeEditorProps) {
  const [expanded, setExpanded] = useState(false);

  const outputSchemaKey = JSON.stringify(outputSchema);

  const completionFn = useMemo(
    () => createSchemaAwareCompletions(outputSchema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputSchemaKey],
  );

  const codeLinter = useMemo(
    () => editorMode === 'code' ? createCodeLinter(outputSchema, nodeType) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorMode, outputSchemaKey, nodeType],
  );

  const fillTheme = useMemo(() => editorFillTheme(expanded ? '60vh' : minHeight), [expanded, minHeight]);

  const extensions = useMemo(
    () => [
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
    ],
    [editorMode, completionFn, codeLinter, fillTheme],
  );

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
                <span className="text-text-tertiary">{editorMode === 'json' ? 'JSON' : 'JavaScript'}</span>
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
              placeholder={placeholder || (editorMode === 'json' ? PLACEHOLDER_JSON : editorMode === 'condition' ? PLACEHOLDER_CONDITION : PLACEHOLDER_CODE)}
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
