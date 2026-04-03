/**
 * validate-code — runs TypeScript type-checking on user code snippets.
 * Generates typed declarations from upstream output schemas and returns
 * diagnostics with character positions for CodeMirror lint integration.
 */
import ts from 'typescript';

export interface CodeDiagnostic {
  from: number; // character offset in the user's code
  to: number; // character offset end
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ValidateCodeInput {
  code: string;
  outputSchema?: Record<string, unknown>;
  /** Node type — determines the function parameter shape ('code-executor' vs 'code-trigger') */
  nodeType?: string;
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * Handles simple types: string, number, boolean, object (with properties), array.
 */
function jsonSchemaToTsType(schema: Record<string, unknown>, indent = 2): string {
  const type = schema.type as string | undefined;

  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) return `Array<${jsonSchemaToTsType(items, indent)}>`;
    return 'unknown[]';
  }
  if (type === 'object' || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) return 'Record<string, unknown>';
    const lines: string[] = [];
    const required = new Set((schema.required as string[]) || []);
    for (const [key, propSchema] of Object.entries(props)) {
      const tsType = jsonSchemaToTsType(propSchema, indent + 2);
      const opt = required.has(key) ? '' : '?';
      const desc = propSchema.description as string | undefined;
      if (desc) lines.push(`${' '.repeat(indent)}/** ${desc} */`);
      lines.push(`${' '.repeat(indent)}${key}${opt}: ${tsType};`);
    }
    return `{\n${lines.join('\n')}\n${' '.repeat(Math.max(0, indent - 2))}}`;
  }
  return 'unknown';
}

/**
 * Generate a TypeScript declaration block for the code executor's environment.
 * These are prepended to the user's code so TS can type-check references to
 * `input`, `config`, `context`, `trigger`, and `fetch`.
 *
 * For code-trigger nodes the parameter shape is different: { config, emit, signal }
 * instead of { input, config, context, trigger }.
 */
function generateDeclarations(outputSchema?: Record<string, unknown>, nodeType?: string): string {
  const inputType = outputSchema ? jsonSchemaToTsType(outputSchema) : 'Record<string, any>';

  if (nodeType === 'code-trigger') {
    return `
interface __CodeTriggerParams {
  config: Record<string, any>;
  emit: (event: any) => void;
  signal: AbortSignal;
}
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
`;
  }

  return `
interface __InputType ${inputType === 'Record<string, any>' ? '{ [key: string]: any }' : inputType}
interface __CodeExecutorParams {
  input: __InputType;
  config: Record<string, any>;
  context: {
    trigger: { type: string; payload: any; source?: string; timestamp?: string };
    stages: Record<string, { latest: any; run_count: number; status: string; runs: any[] }>;
    variables: Record<string, any>;
  };
  trigger: { type: string; payload: any; source?: string; timestamp?: string };
}
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
`;
}

/**
 * Wrap user code so TypeScript can analyze it in context.
 *
 * Handles all common export default function signature patterns:
 *   - export default ({ input, config }) => { ... }        (destructured arrow)
 *   - export default async ({ input, config }) => { ... }  (async destructured arrow)
 *   - export default function({ input, config }) { ... }   (destructured function)
 *   - export default async function({ input, config }) { } (async destructured function)
 *   - export default (input) => { ... }                    (single-param arrow)
 *   - export default function(input) { ... }               (single-param function)
 *   - export default async function(input) { ... }         (single-param async function)
 */
function wrapUserCode(code: string, declarations: string, nodeType?: string): { wrapped: string; offset: number; injectionPos: number; injectionLen: number } {
  const separator = '// --- user code ---\n';
  const destructuredType = nodeType === 'code-trigger' ? '__CodeTriggerParams' : '__CodeExecutorParams';
  // For single-param pattern like function(input), type as the input data directly
  const singleParamType = nodeType === 'code-trigger' ? '__CodeTriggerParams' : '__InputType';

  let typedCode = code;
  let injectionPos = -1; // position in original user code where annotation was inserted
  let injectionLen = 0;  // length of the injected annotation string

  // Pattern 1: Destructured params — export default ({ ... }) => or function({ ... })
  const destructuredRegex = /^(export\s+default\s+(?:async\s+)?(?:function\s*)?)\((\{[^}]*\})\)/m;
  const destructuredMatch = code.match(destructuredRegex);

  if (destructuredMatch) {
    const annotation = `: ${destructuredType}`;
    typedCode = code.replace(destructuredRegex, `$1($2${annotation})`);
    injectionPos = destructuredMatch.index! + destructuredMatch[1].length + 1 + destructuredMatch[2].length;
    injectionLen = annotation.length;
  } else {
    // Pattern 2: Single param — export default function(input) or (input) =>
    const singleParamRegex = /^(export\s+default\s+(?:async\s+)?(?:function\s*)?)\((\w+)\)/m;
    const singleParamMatch = code.match(singleParamRegex);

    if (singleParamMatch) {
      const annotation = `: ${singleParamType}`;
      typedCode = code.replace(singleParamRegex, `$1($2${annotation})`);
      injectionPos = singleParamMatch.index! + singleParamMatch[1].length + 1 + singleParamMatch[2].length;
      injectionLen = annotation.length;
    }
  }

  const prefix = declarations + separator;
  return {
    wrapped: prefix + typedCode,
    offset: prefix.length,
    injectionPos,
    injectionLen,
  };
}

export function validateCode(input: ValidateCodeInput): CodeDiagnostic[] {
  const { code, outputSchema, nodeType } = input;

  if (!code.trim()) return [];

  const declarations = generateDeclarations(outputSchema, nodeType);
  const { wrapped, offset, injectionPos, injectionLen } = wrapUserCode(code, declarations, nodeType);

  const fileName = 'user-code.ts';

  // Use the TypeScript lib directory from the installed typescript package so
  // standard globals (Promise, Array, Map, etc.) are all available.
  const defaultHost = ts.createCompilerHost({});
  const libDir = ts.getDefaultLibFilePath({}).replace(/[^/\\]+$/, '');

  const sourceFile = ts.createSourceFile(fileName, wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, languageVersion) => {
      if (name === fileName) return sourceFile;
      return defaultHost.getSourceFile(name, languageVersion);
    },
    fileExists: (name) => name === fileName || defaultHost.fileExists(name),
    readFile: (name) => {
      if (name === fileName) return wrapped;
      return defaultHost.readFile(name);
    },
    writeFile: () => {},
    getDefaultLibFileName: (options) => defaultHost.getDefaultLibFileName(options),
    getDefaultLibLocation: () => libDir,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };

  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
  }, host);

  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  const result: CodeDiagnostic[] = [];

  for (const diag of diagnostics) {
    if (diag.file !== sourceFile) continue;
    if (diag.start == null || diag.length == null) continue;

    // Map position back to the user's original code.
    // Step 1: subtract the declarations prefix offset
    let from = diag.start - offset;
    let to = from + diag.length;

    // Step 2: if we injected a type annotation into the user's code,
    // adjust positions for diagnostics that occur after the injection point.
    if (injectionLen > 0 && injectionPos >= 0) {
      if (from > injectionPos) {
        from -= injectionLen;
        to -= injectionLen;
      } else if (to > injectionPos) {
        // Diagnostic spans the injection — clamp the end
        to -= injectionLen;
      }
    }

    // Skip diagnostics in the declarations prefix or the injected annotation itself
    if (to <= 0) continue;
    if (from < 0) continue;

    const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');

    // Suppress noise from treating a module snippet as a plain script:
    // export/import keywords are invalid outside a module context but the
    // user's code is expected to use them.
    if (message.includes("'export'")) continue;
    if (message.includes("'import'")) continue;

    const severity: CodeDiagnostic['severity'] =
      diag.category === ts.DiagnosticCategory.Error
        ? 'error'
        : diag.category === ts.DiagnosticCategory.Warning
          ? 'warning'
          : 'info';

    result.push({ from, to, severity, message });
  }

  return result;
}
