/**
 * Code Executor node — runs JavaScript/TypeScript in an isolated child process.
 * Supports npm dependencies via versioned per-workflow workspaces.
 *
 * The user writes a default export function: ({ input, config, context, trigger }) => { ... }
 * `input` is the output from the upstream stage (the primary data source).
 * The function can use top-level imports and any installed dependencies.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as restate from '@restatedev/restate-sdk';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { ensureWorkspace, writeCodeFile, cleanupCodeFile } from '../workspace-manager.js';

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

/**
 * Extract a human-readable error from the raw Node.js child process output.
 * Strips file paths, internal stack frames, and the "Command failed:" prefix.
 */
function cleanCodeError(raw: string): string {
  // Strip the "Command failed: /path/to/node /path/to/file.mjs\n" prefix
  let msg = raw.replace(/^Command failed:.*?\n/s, '');

  // Strip absolute file paths, keep just the filename
  msg = msg.replace(/file:\/\/\/[^\s]+\//g, '');

  // Strip "at ..." stack frames from Node internals
  msg = msg.replace(/\s+at\s+\S+\s+\(node:internal\/[^)]+\)/g, '');

  // Strip trailing "Node.js vX.X.X" line
  msg = msg.replace(/\s*Node\.js v[\d.]+\s*$/, '');

  // Strip repeated "Error: Command failed..." block that echoes the same info
  const errorIdx = msg.indexOf('\nError: Command failed:');
  if (errorIdx > 0) msg = msg.slice(0, errorIdx);

  // Collapse multiple blank lines
  msg = msg.replace(/\n{3,}/g, '\n\n');

  return msg.trim() || raw.trim();
}

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown; logs?: string; stderr?: string }> {
    const { ctx, stageId, config, input, workflowContext, definition, iteration } = execCtx;
    const code = (config.code as string) || 'export default ({ input }) => input;';
    const timeoutMs = ((config.timeout_seconds as number) || 30) * 1000;
    const dependencies = (config.dependencies as Record<string, string>) || {};

    const workflowId = definition.id;
    const version = definition.version ?? 1;

    const result = await ctx.run(`code-exec-${stageId}-${iteration}`, async () => {
      try {
        // 1. Ensure workspace with dependencies
        const workspace = await ensureWorkspace(workflowId, version, dependencies);

        // 2. Build input payload
        const inputPayload = {
          input: input?.sourceOutput ?? {},
          config,
          context: workflowContext,
          trigger: workflowContext.trigger,
        };

        // 3. Write temp code file
        const fileId = `${stageId}-${iteration}-${Date.now()}`;
        const codePath = await writeCodeFile(workspace.runsDir, fileId, code, inputPayload);

        try {
          // 4. Execute in child process
          const { stdout, stderr } = await execFileAsync(
            process.execPath, // use current node binary
            [codePath],
            {
              cwd: workspace.root,
              timeout: timeoutMs,
              env: {
                ...process.env,
                NODE_PATH: workspace.nodeModules,
              },
              maxBuffer: 10 * 1024 * 1024, // 10MB
            },
          );

          if (stderr?.trim()) {
            console.warn(`[code-executor] stderr from ${stageId}:`, stderr.trim().slice(0, 500));
          }

          // 5. Extract user console output (everything before the sentinel markers)
          const sentinelIdx = stdout.lastIndexOf(OUTPUT_START);
          const userLogs = sentinelIdx > 0 ? stdout.slice(0, sentinelIdx).trim() : '';

          // 6. Extract output from stdout
          return {
            output: extractOutput(stdout),
            logs: userLogs || undefined,
            stderr: stderr?.trim() || undefined,
          };
        } finally {
          // 7. Cleanup temp file
          await cleanupCodeFile(codePath);
        }
      } catch (err) {
        // User code failures (syntax errors, runtime errors, timeouts) won't fix on retry.
        // Throw TerminalError so Restate stops retrying this step.
        // Clean up the raw Node.js error to extract just the useful parts.
        const raw = err instanceof Error ? err.message : String(err);
        const cleaned = cleanCodeError(raw);
        throw new restate.TerminalError(cleaned);
      }
    });

    return { output: result.output, logs: result.logs, stderr: result.stderr };
  },
};

export const codeExecutorNodeSpec: NodeTypeSpec = {
  id: 'code-executor',
  name: 'Code Executor',
  category: 'step',
  description: 'Run custom JavaScript with npm package support',
  icon: 'code',
  color: { bg: '#fff7ed', border: '#f97316', text: '#ea580c' },
  configSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        title: 'Code',
        description:
          'JavaScript/TypeScript module with a default export function. The `input` parameter contains the output from the upstream stage — use input.fieldName to access upstream data. Also available: config (this node\'s settings), context (context.stages["stage-id"].latest for other stages), trigger (the original trigger event). Supports ES module imports.',
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
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing this node\'s output. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['code'],
  },
  defaultConfig: { code: '', dependencies: {}, timeout_seconds: 30 },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: { type: 'string', title: 'Condition', format: 'code' },
    },
  },
};
