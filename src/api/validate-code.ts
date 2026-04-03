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
 */
function generateDeclarations(outputSchema?: Record<string, unknown>): string {
  const inputType = outputSchema ? jsonSchemaToTsType(outputSchema) : 'Record<string, any>';

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
 * The user writes: export default ({ input, config, context, trigger }) => { ... }
 * We need to type that destructured parameter. Strategy: replace the function
 * signature to add our type annotation.
 */
function wrapUserCode(code: string, declarations: string): { wrapped: string; offset: number } {
  const separator = '// --- user code ---\n';

  // Try to inject type annotation into the function signature.
  // Match patterns like:
  //   export default ({ input, ... }) =>
  //   export default function({ input, ... })
  //   export default async ({ input, ... }) =>
  //   export default async function({ input, ... })
  const paramRegex = /^(export\s+default\s+(?:async\s+)?(?:function\s*)?\()(\{[^}]*\})(\))/m;
  const match = code.match(paramRegex);

  let typedCode = code;
  if (match) {
    // Insert type annotation: ({ input, ... }: __CodeExecutorParams) =>
    typedCode = code.replace(paramRegex, `$1$2: __CodeExecutorParams$3`);
  }

  const prefix = declarations + separator;
  return {
    wrapped: prefix + typedCode,
    offset: prefix.length,
  };
}

export function validateCode(input: ValidateCodeInput): CodeDiagnostic[] {
  const { code, outputSchema } = input;

  if (!code.trim()) return [];

  const declarations = generateDeclarations(outputSchema);
  const { wrapped, offset } = wrapUserCode(code, declarations);

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

    // Map position back to the user's original code
    const from = diag.start - offset;
    const to = from + diag.length;

    // Skip diagnostics that fall entirely within the declarations prefix
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
