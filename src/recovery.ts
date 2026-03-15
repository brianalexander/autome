/**
 * Crash recovery — runs on server startup before accepting connections.
 * Cleans up stale state from previous crashes/restarts.
 */

import type { OrchestratorDB } from './db/database.js';
import type { AcpProvider } from './acp/provider/types.js';

export async function runCrashRecovery(db: OrchestratorDB, provider: AcpProvider): Promise<void> {
  console.log('[recovery] Running crash recovery...');

  // 1. Mark all active ACP sessions as errored and clear PIDs
  db.clearAcpSessionPids();

  // 2. Mark any in-progress instances as failed
  try {
    let totalMarked = 0;
    for (const status of ['running', 'waiting_gate', 'waiting_input']) {
      const { data } = db.listInstances({ status, includeTest: true });
      for (const inst of data) {
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
