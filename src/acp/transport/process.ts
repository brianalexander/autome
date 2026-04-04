import { type ChildProcess, spawn, execSync, exec } from 'child_process';
import { promisify } from 'util';
import { JsonRpcTransport } from './json-rpc.js';

const execAsync = promisify(exec);

export interface ProcessSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Optional filter applied to each incoming message. Return false to drop. */
  messageFilter?: (msg: unknown) => boolean;
}

export interface ProcessShutdownOptions {
  /** Skip graceful shutdown, kill immediately */
  immediate?: boolean;
  /** Milliseconds before escalating from stdin close to SIGTERM. Default: 500 */
  graceMs?: number;
  /** Milliseconds before escalating from SIGTERM to SIGKILL. Default: 2000 */
  killMs?: number;
}

/**
 * Manages a child process with JSON-RPC transport over stdio.
 *
 * Handles:
 * - Process spawning with stdio pipes
 * - Stderr capture
 * - Multi-phase graceful shutdown (close stdin → SIGTERM → SIGKILL)
 * - Cross-platform process tree cleanup
 */
export class ProcessHandle {
  private process: ChildProcess | null = null;
  private _transport: JsonRpcTransport | null = null;
  private _stderrBuffer = '';
  private _destroyed = false;
  private onStderr?: (text: string) => void;
  private onClose?: (info: { code: number | null; signal: string | null; stderr: string }) => void;
  private onError?: (err: Error) => void;

  /**
   * Spawn the process and return the transport.
   * Call this once — subsequent calls throw.
   */
  spawn(options: ProcessSpawnOptions): JsonRpcTransport {
    if (this.process) throw new Error('Process already spawned');

    this.process = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });

    this._transport = new JsonRpcTransport(
      this.process.stdout!,
      this.process.stdin!,
      options.messageFilter ? { messageFilter: options.messageFilter } : undefined,
    );

    this.process.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        this._stderrBuffer += text;
        this.onStderr?.(text);
      }
    });

    this.process.on('close', (code, signal) => {
      this._destroyed = true;
      this._transport?.close();
      this.onClose?.({ code, signal, stderr: this._stderrBuffer.trim() });
    });

    this.process.on('error', (err) => {
      this.onError?.(err);
    });

    return this._transport;
  }

  get transport(): JsonRpcTransport | null {
    return this._transport;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get stderrBuffer(): string {
    return this._stderrBuffer;
  }

  /** Register callbacks for process events */
  onProcessEvent(handlers: {
    stderr?: (text: string) => void;
    close?: (info: { code: number | null; signal: string | null; stderr: string }) => void;
    error?: (err: Error) => void;
  }): void {
    this.onStderr = handlers.stderr;
    this.onClose = handlers.close;
    this.onError = handlers.error;
  }

  /**
   * Shut down the process.
   * Default: close stdin → SIGTERM (500ms) → SIGKILL (2.5s)
   * Immediate: SIGKILL now
   */
  destroy(options?: ProcessShutdownOptions): void {
    this._destroyed = true;
    this._transport?.close();

    if (!this.process || this.process.killed) return;

    if (options?.immediate) {
      this.killProcessTree(this.process.pid!);
      try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
      return;
    }

    // Phase 1: Close stdin — lets agent detect EOF and flush
    try { this.process.stdin?.end(); } catch { /* may already be closed */ }

    // Phase 2: SIGTERM after grace period
    const graceMs = options?.graceMs ?? 500;
    const killMs = options?.killMs ?? 2000;

    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.killProcessTree(this.process.pid!);
        try { this.process.kill('SIGTERM'); } catch { /* already dead */ }
      }
      // Phase 3: SIGKILL after kill period
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          try { this.process.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, killMs);
    }, graceMs);
  }

  /** Close stdin to signal the process. Used before cancel. */
  closeStdin(): void {
    try { this.process?.stdin?.end(); } catch { /* already closed */ }
  }

  /** Run a shell command in the process working directory */
  async execInCwd(command: string, cwd: string, timeoutMs = 60000): Promise<string> {
    const { stdout } = await execAsync(command, { cwd, timeout: timeoutMs });
    return stdout;
  }

  // --- Process tree cleanup ---

  private killProcessTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${pid} /T /F`, { timeout: 5000 });
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            const children = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', timeout: 5000 }).trim();
            for (const childPid of children.split('\n').filter(Boolean)) {
              const cpid = parseInt(childPid, 10);
              if (!isNaN(cpid)) {
                this.killProcessTree(cpid);
                try { process.kill(cpid, 'SIGKILL'); } catch { /* already dead */ }
              }
            }
          } catch { /* no children or pgrep unavailable */ }
        }
      }
    } catch { /* process already dead */ }
  }
}
