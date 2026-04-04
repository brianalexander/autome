/**
 * Shell Executor node — runs bash/shell commands as a processing step.
 *
 * The command string supports template expressions: ${input.field},
 * ${trigger.data}, ${context.stages.stageId.latest.field}, etc.
 * These are evaluated via safeEval against the available data.
 *
 * stdout is parsed as JSON when parse_json is true (default). On parse
 * failure the raw stdout, stderr, and exit code are returned instead.
 * Non-zero exits throw an error so the workflow engine can handle failure.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as restate from '@restatedev/restate-sdk';
import type { NodeTypeSpec, StepExecutor, StepExecutorContext } from '../types.js';
import { safeEval } from '../../engine/safe-eval.js';

const execFileAsync = promisify(execFile);

/**
 * Interpolate ${...} template expressions in a command string.
 * Each expression is evaluated with safeEval against the provided variables.
 * Unknown expressions are left as-is.
 */
export function interpolateCommand(
  command: string,
  variables: Record<string, unknown>,
): string {
  return command.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    try {
      const result = safeEval(expr.trim(), variables);
      return result == null ? '' : String(result);
    } catch {
      return _match; // leave unresolvable expressions intact
    }
  });
}

const executor: StepExecutor = {
  type: 'step',
  async execute(execCtx: StepExecutorContext): Promise<{ output: unknown }> {
    const { ctx, stageId, config, input, workflowContext, iteration } = execCtx;

    const rawCommand = (config.command as string) || '';
    const timeoutMs = ((config.timeout_seconds as number) || 30) * 1000;
    const shell = (config.shell as string) || '/bin/bash';
    const parseJson = config.parse_json !== false; // default true

    const output = await ctx.run(`shell-exec-${stageId}-${iteration}`, async () => {
      // Build template variables — same shape as code-executor input payload
      const templateVars: Record<string, unknown> = {
        input: input?.sourceOutput ?? {},
        config,
        context: workflowContext,
        trigger: workflowContext.trigger,
      };

      const command = interpolateCommand(rawCommand, templateVars);

      if (!command.trim()) {
        throw new Error('[shell-executor] command is empty after interpolation');
      }

      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      try {
        const result = await execFileAsync(shell, ['-c', command], {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: process.env,
        });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
      } catch (err: unknown) {
        // execFile rejects on non-zero exit or timeout
        const execErr = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
        stdout = execErr.stdout ?? '';
        stderr = execErr.stderr ?? '';
        exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

        if (execErr.killed) {
          throw new restate.TerminalError(
            `[shell-executor] command timed out after ${timeoutMs / 1000}s\nstderr: ${stderr.slice(0, 500)}`,
          );
        }

        throw new restate.TerminalError(
          `[shell-executor] command exited with code ${exitCode}\nstderr: ${stderr.slice(0, 500)}`,
        );
      }

      if (stderr.trim()) {
        console.warn(`[shell-executor] stderr from ${stageId}:`, stderr.trim().slice(0, 500));
      }

      if (parseJson) {
        try {
          const parsed = JSON.parse(stdout.trim());
          // Augment with process metadata
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return { ...parsed, stderr, exitCode };
          }
          // For arrays or primitives, wrap in a result envelope
          return { result: parsed, stdout: stdout.trim(), stderr, exitCode };
        } catch {
          // Fall through to raw output
        }
      }

      return { stdout: stdout.trim(), stderr, exitCode };
    });

    return { output };
  },
};

export const shellExecutorNodeSpec: NodeTypeSpec = {
  id: 'shell-executor',
  name: 'Shell / CLI',
  category: 'step',
  description: 'Run shell commands and capture their output',
  icon: 'terminal',
  color: { bg: '#f8fafc', border: '#64748b', text: '#475569' },
  configSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        title: 'Command',
        description:
          'Shell command to execute. Use ${input.fieldName} to reference upstream stage output (primary data). Also: ${context.stages["stage-id"].latest.field} for other stages, ${trigger.payload} for the trigger event.',
        format: 'code',
      },
      timeout_seconds: {
        type: 'number',
        title: 'Timeout (seconds)',
        description: 'Max execution time (default: 30s)',
        default: 30,
      },
      shell: {
        type: 'string',
        title: 'Shell',
        description: 'Shell binary to use (default: /bin/bash)',
        default: '/bin/bash',
      },
      parse_json: {
        type: 'boolean',
        title: 'Parse JSON output',
        description: 'Attempt to parse stdout as JSON (default: true)',
        default: true,
      },
      output_schema: {
        type: 'object',
        title: 'Output Schema',
        description: 'JSON Schema describing this node\'s output. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['command'],
  },
  defaultConfig: {
    command: '',
    timeout_seconds: 30,
    shell: '/bin/bash',
    parse_json: true,
    output_schema: {
      type: 'object',
      properties: {
        stdout: { type: 'string', description: 'Raw stdout output' },
        stderr: { type: 'string', description: 'Stderr output' },
        exitCode: { type: 'number', description: 'Process exit code' },
      },
    },
  },
  executor,
  outEdgeSchema: {
    type: 'object',
    properties: {
      condition: { type: 'string', title: 'Condition', format: 'code' },
    },
  },
};
