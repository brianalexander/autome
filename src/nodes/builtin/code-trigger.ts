/**
 * Code Trigger node — runs user-provided JavaScript as a long-running process
 * that can emit workflow trigger events over time.
 *
 * The user writes a default-export function:
 *   export default ({ config, emit, signal }) => { ... }
 *
 * The function is expected to set up a long-running operation (polling, WebSocket,
 * file watch, etc.) and call emit() whenever an event should trigger the workflow.
 * The AbortSignal fires when the trigger is deactivated.
 */
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { NodeTypeSpec, TriggerExecutor } from '../types.js';
import { ensureWorkspace } from '../workspace-manager.js';

/** Sentinel prefix used by the wrapper to communicate events to the parent */
const EVENT_PREFIX = '__TRIGGER_EVENT__:';

/**
 * Build the wrapper script content that will be written to the workspace.
 * The wrapper imports the user's code, wires up emit() over stdout, and
 * forwards SIGTERM/SIGINT to the AbortController.
 */
function buildWrapperScript(userCodeFile: string): string {
  return `import userFn from './${userCodeFile}';

const config = JSON.parse(process.env.TRIGGER_CONFIG || '{}');
const ac = new AbortController();

function emit(event) {
  process.stdout.write('${EVENT_PREFIX}' + JSON.stringify(event) + '\\n');
}

process.on('SIGTERM', () => { ac.abort(); setTimeout(() => process.exit(0), 1000); });
process.on('SIGINT',  () => { ac.abort(); setTimeout(() => process.exit(0), 1000); });

try {
  await userFn({ config, emit, signal: ac.signal });
} catch (err) {
  process.stderr.write('Code trigger error: ' + (err?.message ?? String(err)) + '\\n');
  process.exit(1);
}
`;
}

const executor: TriggerExecutor = {
  type: 'trigger',

  async activate(workflowId, stageId, config, emit) {
    const code = (config.code as string) || '';
    const dependencies = (config.dependencies as Record<string, string>) || {};
    const timeoutSeconds = (config.timeout_seconds as number) || 0;

    // 1. Ensure workspace with user's dependencies
    const workspace = await ensureWorkspace(workflowId, 1, dependencies);

    // 2. Write user code file and wrapper file to the system temp directory so
    //    the OS handles cleanup if the process crashes before deactivation.
    const fileId = `${stageId}-trigger-${Date.now()}`;
    const userCodeFile = `${fileId}_code.mjs`;
    const wrapperFile = `${fileId}_wrapper.mjs`;
    const userCodePath = join(tmpdir(), userCodeFile);
    const wrapperPath = join(tmpdir(), wrapperFile);

    await writeFile(userCodePath, code, 'utf-8');
    await writeFile(wrapperPath, buildWrapperScript(userCodeFile), 'utf-8');

    console.log(`[code-trigger] Spawning trigger process for workflow ${workflowId} (stage ${stageId})`);

    // 3. Spawn long-running child process
    const child = spawn(process.execPath, [wrapperPath], {
      cwd: workspace.root,
      env: {
        ...process.env,
        NODE_PATH: workspace.nodeModules,
        TRIGGER_CONFIG: JSON.stringify(config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Buffer for partial lines arriving across chunks
    let lineBuffer = '';

    // 4. Listen on stdout for __TRIGGER_EVENT__ lines
    child.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      // All but the last segment are complete lines
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith(EVENT_PREFIX)) continue;
        const jsonStr = trimmed.slice(EVENT_PREFIX.length);
        try {
          const event = JSON.parse(jsonStr) as Record<string, unknown>;
          emit(event);
        } catch {
          console.warn(`[code-trigger] Failed to parse trigger event JSON: ${jsonStr.slice(0, 200)}`);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      console.warn(`[code-trigger] stderr (${workflowId}/${stageId}):`, chunk.toString('utf-8').trim().slice(0, 500));
    });

    child.on('error', (err) => {
      console.error(`[code-trigger] Child process error for workflow ${workflowId}:`, err.message);
    });

    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.warn(`[code-trigger] Trigger process exited with code=${code} signal=${signal} (workflow ${workflowId})`);
      }
    });

    // Optional hard timeout — kill after N seconds if configured
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        console.log(`[code-trigger] Timeout reached for workflow ${workflowId}, killing trigger process`);
        child.kill('SIGTERM');
      }, timeoutSeconds * 1000);
    }

    // 5. Return cleanup function
    return () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      child.kill('SIGTERM');
      console.log(`[code-trigger] Deactivated trigger for workflow ${workflowId} (stage ${stageId})`);

      // Best-effort cleanup of temp files
      Promise.all([unlink(userCodePath), unlink(wrapperPath)]).catch(() => {});
    };
  },
};

export const codeTriggerSpec: NodeTypeSpec = {
  id: 'code-trigger',
  name: 'Code Trigger',
  category: 'trigger',
  description: 'Run custom JavaScript as a long-running trigger that emits events',
  icon: 'plug',
  color: { bg: '#faf5ff', border: '#a855f7', text: '#9333ea' },
  configSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        title: 'Code',
        description:
          'JavaScript module with a default export function. Receives { config, emit, signal }. ' +
          'Call emit(event) to trigger the workflow. Use signal (AbortSignal) to detect shutdown.',
        format: 'code',
      },
      dependencies: {
        type: 'object',
        title: 'Dependencies',
        description:
          'npm packages to install. Key = package name, value = version range. Example: { "node-fetch": "^3.0.0" }',
        format: 'dependencies',
        additionalProperties: { type: 'string' },
      },
      timeout_seconds: {
        type: 'number',
        title: 'Timeout (seconds)',
        description: 'Max run time before the trigger process is killed (0 = no timeout, run indefinitely)',
        default: 0,
      },
      output_schema: {
        type: 'object',
        title: 'Event Schema',
        description: 'JSON Schema describing the shape of events emitted by this trigger. Used for design-time validation of downstream references.',
        format: 'json',
      },
    },
    required: ['code'],
  },
  defaultConfig: {
    code: '',
    dependencies: {},
    timeout_seconds: 0,
    output_schema: {
      type: 'object',
      description: 'Events emitted by this trigger. Define the shape of objects passed to emit().',
    },
  },
  triggerMode: 'immediate',
  executor,
};
