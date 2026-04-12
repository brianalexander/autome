/**
 * Crash recovery — runs on server startup before accepting connections.
 * Cleans up stale state from previous crashes/restarts.
 */

import { execSync } from 'child_process';
import type { OrchestratorDB } from './db/database.js';
import type { AcpProvider } from './acp/provider/types.js';
import { cancelWorkflow } from './restate/client.js';

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

  // 1. Kill any orphaned processes from the previous run, then clear PIDs
  const stalePids = db.getActiveSessionPids();
  if (stalePids.length > 0) {
    console.log(`[recovery] Killing ${stalePids.length} orphaned process(es): ${stalePids.join(', ')}`);
    for (const pid of stalePids) {
      killOrphanTree(pid);
    }
  }
  db.clearAcpSessionPids();

  // 2. Mark any in-progress instances as failed, with best-effort Restate cancellation
  try {
    let totalMarked = 0;
    for (const status of ['running', 'waiting_gate', 'waiting_input']) {
      const { data } = db.listInstances({ status, includeTest: true });
      for (const inst of data) {
        // Best-effort: cancel the Restate workflow before marking failed in DB.
        // Restate may not be running during recovery, so we swallow errors here.
        try {
          await cancelWorkflow(inst.id);
        } catch {
          // Restate unavailable or workflow already gone — safe to ignore
        }
        db.updateInstance(inst.id, { status: 'failed' });
      }
      totalMarked += data.length;
    }
    if (totalMarked > 0) {
      console.log(`[recovery] Marked ${totalMarked} in-progress instance(s) as failed`);
    }
  } catch (err) {
    console.error('[recovery] Error marking instances:', err);
  }

  // 3. Delete orphaned test workflows (created by test-run, not cleaned up)
  try {
    const deleted = db.deleteTestWorkflows();
    if (deleted > 0) {
      console.log(`[recovery] Cleaned up ${deleted} orphaned test workflow(s)`);
    }
  } catch (err) {
    console.error('[recovery] Error cleaning test workflows:', err);
  }

  // 4. Clean stale session lock files (provider-specific)
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
