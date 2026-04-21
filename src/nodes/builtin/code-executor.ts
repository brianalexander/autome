/**
 * Code Executor node — runs JavaScript/TypeScript in an isolated child process.
 * Supports npm dependencies via versioned per-workflow workspaces.
 *
 * The user writes an arrow function: ({ input, config }) => { ... }
 * The function can use top-level imports and any installed dependencies.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { ensureWorkspace, writeCodeFile, cleanupCodeFile } from '../workspace-manager.js';
import { buildExecutorScope } from '../executor-scope.js';

const execFileAsync = promisify(execFile);

/** Sentinel markers to extract output from stdout (user code may console.log) */
const OUTPUT_START = '__CODE_EXEC_OUTPUT_START__';
const OUTPUT_END = '__CODE_EXEC_OUTPUT_END__';

function extractOutput(stdout: string): unknown {
  const startIdx = stdout.lastIndexOf(OUTPUT_START);
  const endIdx = stdout.lastIndexOf(OUTPUT_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('Code did not return a value. Make sure your function returns something.');
  }
  const jsonStr = stdout.slice(startIdx + OUTPUT_START.length, endIdx).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`Code returned invalid JSON: ${jsonStr.slice(0, 200)}`);
  }
}

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { stageId, config, definition, iteration } = execCtx;
    const code = (config.code as string) || 'export default ({ input }) => input;';
    const timeoutMs = ((config.timeout_seconds as number) || 30) * 1000;
    const dependencies = (config.dependencies as Record<string, string>) || {};

    const workflowId = definition.id;
    const version = definition.version ?? 1;

    const output = await (async () => {
      // 1. Ensure workspace with dependencies
      const workspace = await ensureWorkspace(workflowId, version, dependencies);

      // 2. Build input payload
      const scope = buildExecutorScope(execCtx);
      const inputPayload = { input: scope.input, config };
      const secretsEnv = execCtx.secrets ? JSON.stringify(execCtx.secrets) : undefined;

      // 3. Write temp code file
      const fileId = `${stageId}-${iteration}-${Date.now()}`;
      const codePath = await writeCodeFile(workspace.runsDir, fileId, code, inputPayload);

      try {
        // 4. Execute in child process with tsx for TypeScript support
        const nodeArgs: string[] = [
          '--import', 'tsx/esm',
        ];
        if (config.sandbox !== false) {
          // Enable Node.js permission model (stable in Node 24+).
          // Grants read access to workspace root (contains node_modules/ and runs/)
          // but denies fs writes, child_process, and worker_threads.
          // fetch() / network is unrestricted by the permission model.
          nodeArgs.push(
            '--permission',
            `--allow-fs-read=${workspace.root}`,
          );
        }
        nodeArgs.push(codePath);

        const { stdout, stderr } = await execFileAsync(
          process.execPath, // use current node binary
          nodeArgs,
          {
            cwd: workspace.root,
            timeout: timeoutMs,
            env: {
              ...process.env,
              NODE_PATH: workspace.nodeModules,
              ...(secretsEnv ? { __AUTOME_SECRETS__: secretsEnv } : {}),
            },
            maxBuffer: 10 * 1024 * 1024, // 10MB
          },
        );

        if (stderr?.trim()) {
          console.warn(`[code-executor] stderr from ${stageId}:`, stderr.trim().slice(0, 500));
        }

        // 5. Extract output from stdout
        return extractOutput(stdout);
      } finally {
        // 6. Cleanup temp file
        await cleanupCodeFile(codePath);
      }
    })();

    return { output };
  },
};

export const codeExecutorNodeSpec: NodeTypeSpec = {
  id: 'code-executor',
  name: 'Code Executor',
  category: 'step',
  description: 'Run custom JavaScript with npm package support',
  icon: '⚡',
  color: { bg: '#fff7ed', border: '#f97316', text: '#ea580c' },
  configSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        title: 'Code',
        description:
          'JavaScript/TypeScript module with a default export function. Receives { input, config } where input is Record<stageId, upstreamOutput>. Supports ES module imports.',
        format: 'code',
      },
      dependencies: {
        type: 'object',
        title: 'Dependencies',
        description:
          'npm packages to install. Key = package name, value = version range. Example: { "lodash": "^4.17.21" }',
        format: 'dependencies',
        additionalProperties: { type: 'string' },
      },
      timeout_seconds: {
        type: 'number',
        title: 'Timeout (seconds)',
        description: 'Max execution time (default: 30s)',
        default: 30,
        'x-widget': 'slider',
        minimum: 5,
        maximum: 300,
        multipleOf: 5,
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing this node\'s output shape. Enables type hints for downstream nodes.',
        format: 'json',
        additionalProperties: true,
      },
      sandbox: {
        type: 'boolean',
        title: 'Sandbox',
        description: 'When true (default), restricts filesystem and subprocess access using the Node.js permission model. Code can still use fetch() and npm imports. Set to false for full Node.js access (child_process, fs, etc).',
        default: true,
      },
    },
    required: ['code', 'output_schema'],
  },
  defaultConfig: { code: '', dependencies: {}, timeout_seconds: 30, sandbox: true },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: { type: 'string', title: 'Condition', format: 'code' },
    },
  },
};
