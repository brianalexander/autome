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
  /** Validation mode — 'function' wraps as a function body (default), 'expression' wraps as a typed expression */
  validationMode?: 'function' | 'expression';
  /** The node's OWN output schema — validates the function's return value */
  returnSchema?: Record<string, unknown>;
  /** When false, Node.js built-in module declarations (child_process, fs, etc.) are available */
  sandbox?: boolean;
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * Handles simple types: string, number, boolean, object (with properties), array.
 */
function jsonSchemaToTsType(schema: Record<string, unknown>, indent = 2): string {
  if (schema.oneOf) {
    const variants = (schema.oneOf as Record<string, unknown>[]).map((v) => jsonSchemaToTsType(v, indent));
    return variants.join(' | ');
  }

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
 * `input`, `config`, and `fetch`.
 *
 * For code-trigger nodes the parameter shape is different: { config, emit, signal }
 * instead of { input, config }.
 */
function generateDeclarations(outputSchema?: Record<string, unknown>, nodeType?: string, returnSchema?: Record<string, unknown>, sandbox?: boolean): string {
  const inputType = outputSchema ? jsonSchemaToTsType(outputSchema) : 'Record<string, any>';
  const returnTypeDecl = returnSchema ? `\ntype __ReturnType = ${jsonSchemaToTsType(returnSchema)};\n` : '';

  if (nodeType === 'code-trigger') {
    // For code-triggers, returnSchema describes what's passed to emit(), not the function return.
    const emitType = returnSchema ? '__EmitType' : 'any';
    const emitTypeDecl = returnSchema ? `\ntype __EmitType = ${jsonSchemaToTsType(returnSchema)};\n` : '';
    return `${emitTypeDecl}
interface __CodeTriggerParams {
  config: Record<string, any>;
  emit: (event: ${emitType}) => void;
  signal: AbortSignal;
}
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
`;
  }

  const resolvedInputType = inputType === 'Record<string, any>' ? 'Record<string, any>' : inputType;
  return `
type __InputType = ${resolvedInputType};
interface __CodeExecutorParams {
  input: __InputType;
  config: Record<string, any>;
}
declare function fetch(url: string, init?: RequestInit): Promise<Response>;
${returnTypeDecl}`;
}

/**
 * Generate standalone declare constants for expression validation mode.
 * Provides typed `output` and `input` as ambient declarations rather than
 * function parameters.
 */
function generateExpressionDeclarations(outputSchema?: Record<string, unknown>): string {
  const outputType = outputSchema ? jsonSchemaToTsType(outputSchema) : 'Record<string, any>';

  return `
type __OutputType = ${outputType === 'Record<string, any>' ? 'Record<string, any>' : outputType};
declare const output: __OutputType;
declare const input: __OutputType;
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
function wrapUserCode(code: string, declarations: string, nodeType?: string, returnSchema?: Record<string, unknown>): { wrapped: string; offset: number; injectionPos: number; injectionLen: number } {
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

  // Code-triggers return void (they call emit() instead), so no return annotation
  const shouldAnnotateReturn = returnSchema && nodeType !== 'code-trigger';

  if (destructuredMatch) {
    const paramAnnotation = `: ${destructuredType}`;
    const isAsync = destructuredMatch[1].includes('async');
    const returnAnnotation = shouldAnnotateReturn
      ? (isAsync ? ': Promise<__ReturnType>' : ': __ReturnType')
      : '';
    typedCode = code.replace(destructuredRegex, `$1($2${paramAnnotation})${returnAnnotation}`);
    injectionPos = destructuredMatch.index! + destructuredMatch[1].length + 1 + destructuredMatch[2].length;
    injectionLen = paramAnnotation.length + returnAnnotation.length;
  } else {
    // Pattern 2: Single param — export default function(input) or (input) =>
    const singleParamRegex = /^(export\s+default\s+(?:async\s+)?(?:function\s*)?)\((\w+)\)/m;
    const singleParamMatch = code.match(singleParamRegex);

    if (singleParamMatch) {
      const paramAnnotation = `: ${singleParamType}`;
      const isAsync = singleParamMatch[1].includes('async');
      const returnAnnotation = shouldAnnotateReturn
        ? (isAsync ? ': Promise<__ReturnType>' : ': __ReturnType')
        : '';
      typedCode = code.replace(singleParamRegex, `$1($2${paramAnnotation})${returnAnnotation}`);
      injectionPos = singleParamMatch.index! + singleParamMatch[1].length + 1 + singleParamMatch[2].length;
      injectionLen = paramAnnotation.length + returnAnnotation.length;
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

/**
 * Wrap user code as an expression for expression validation mode.
 * The expression is assigned to `__expr_result` so TypeScript evaluates it.
 * No function signature injection is performed — offset tracks the prefix only.
 */
function wrapUserExpression(code: string, declarations: string): { wrapped: string; offset: number; injectionPos: number; injectionLen: number } {
  const separator = '// --- user code ---\n';
  const prefix = declarations + separator;
  const wrapper = `const __expr_result = (${code}\n);`;
  return {
    wrapped: prefix + wrapper,
    // The user's code starts after the prefix and the `const __expr_result = (` leader
    offset: prefix.length + 'const __expr_result = ('.length,
    injectionPos: -1,
    injectionLen: 0,
  };
}

export function validateCode(input: ValidateCodeInput): CodeDiagnostic[] {
  const { code, outputSchema, nodeType, validationMode = 'function', returnSchema, sandbox } = input;

  if (!code.trim()) return [];

  let wrapped: string;
  let offset: number;
  let injectionPos: number;
  let injectionLen: number;

  if (validationMode === 'expression') {
    const declarations = generateExpressionDeclarations(outputSchema);
    ({ wrapped, offset, injectionPos, injectionLen } = wrapUserExpression(code, declarations));
  } else {
    const declarations = generateDeclarations(outputSchema, nodeType, returnSchema, sandbox);
    ({ wrapped, offset, injectionPos, injectionLen } = wrapUserCode(code, declarations, nodeType, returnSchema));
  }

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
    types: sandbox === false ? ['node'] : [],
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

    // Suppress false positive: "Did you forget to include 'void' in your type
    // argument to 'Promise'?" — common JS async pattern, not a real bug.
    if (message.includes("Did you forget to include 'void' in your type argument to 'Promise'?")) continue;

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
