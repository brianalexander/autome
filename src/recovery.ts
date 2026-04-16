/**
 * Crash recovery — runs on server startup before accepting connections.
 * Cleans up stale state from previous crashes/restarts.
 *
 * Note: workflow execution recovery (re-queuing non-terminal instances) is
 * handled by WorkflowRunner.resumeAllFromDB(), called after this function.
 * This module only deals with OS-level cleanup (orphan processes, lock files).
 */

import { execSync } from 'child_process';
import type { OrchestratorDB } from './db/database.js';
import type { AcpProvider } from './acp/provider/types.js';

/**
 * Kill a process and its entire subtree.
 * Finds children via pgrep BEFORE killing the parent (killing the parent first
 * would reparent children to init, making them invisible to pgrep -P).
 */
function killOrphanTree(pid: number): void {
  try {
    // Recurse into children first
    try {
      const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', timeout: 5000 }).trim();
      for (const child of out.split('\n').filter(Boolean)) {
        const cpid = parseInt(child, 10);
        if (!isNaN(cpid) && cpid > 0) killOrphanTree(cpid);
      }
    } catch { /* no children or pgrep unavailable */ }

    // Kill the process group first (works if the child was spawned with detached: true)
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader or dead */ }
    // Then the process itself
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  } catch { /* process may already be dead */ }
}

export async function runCrashRecovery(db: OrchestratorDB, provider: AcpProvider): Promise<void> {
  console.log('[recovery] Running crash recovery...');

  // 1. Kill any orphaned ACP processes from the previous run, then clear PIDs
  const stalePids = db.getActiveSessionPids();
  if (stalePids.length > 0) {
    console.log(`[recovery] Killing ${stalePids.length} orphaned process(es): ${stalePids.join(', ')}`);
    for (const pid of stalePids) {
      killOrphanTree(pid);
    }
  }
  db.clearAcpSessionPids();

  // 2. Delete orphaned test workflows (created by test-run, not cleaned up)
  try {
    const deleted = db.deleteTestWorkflows();
    if (deleted > 0) {
      console.log(`[recovery] Cleaned up ${deleted} orphaned test workflow(s)`);
    }
  } catch (err) {
    console.error('[recovery] Error cleaning test workflows:', err);
  }

  // 3. Clean stale session lock files (provider-specific)
  try {
    if (provider.cleanupSessionLocks) {
      await provider.cleanupSessionLocks();
      console.log('[recovery] Cleaned stale provider lock files');
    } else {
      console.debug('[recovery] Provider does not support cleanupSessionLocks — skipping');
    }
  } catch (err) {
    console.error('[recovery] Error cleaning lock files:', err);
  }

  console.log('[recovery] Done');
}
