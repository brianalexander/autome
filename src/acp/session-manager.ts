/**
 * Manages idle session cleanup.
 * Instance-scoped (no global state) — one per pool.
 */
export class SessionManager {
  private activeTurns = new Set<string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private mostRecentKey: string | null = null;
  private destroyFn: ((key: string) => void) | null = null;

  constructor(private opts: {
    recentIdleMs?: number; // Default: 15 min
    otherIdleMs?: number;  // Default: 5 min
  } = {}) {}

  get recentIdleMs(): number {
    return this.opts.recentIdleMs ?? 15 * 60 * 1000;
  }

  get otherIdleMs(): number {
    return this.opts.otherIdleMs ?? 5 * 60 * 1000;
  }

  /** Set the destroy callback */
  setDestroyFn(fn: (key: string) => void): void {
    this.destroyFn = fn;
  }

  onTurnStart(key: string): void {
    this.activeTurns.add(key);
    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }
  }

  onTurnEnd(key: string): void {
    this.activeTurns.delete(key);

    // Demote previous most-recent to shorter timeout
    if (this.mostRecentKey && this.mostRecentKey !== key && !this.activeTurns.has(this.mostRecentKey)) {
      this.scheduleIdle(this.mostRecentKey, this.otherIdleMs);
    }

    this.mostRecentKey = key;
    this.scheduleIdle(key, this.recentIdleMs);
  }

  /** Clear all timers (for shutdown) */
  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.activeTurns.clear();
  }

  private scheduleIdle(key: string, ms: number): void {
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);
    this.idleTimers.set(key, setTimeout(() => {
      this.idleTimers.delete(key);
      if (this.activeTurns.has(key)) return;
      console.log(`[session-manager] Destroying idle session: ${key}`);
      this.destroyFn?.(key);
    }, ms));
  }
}
