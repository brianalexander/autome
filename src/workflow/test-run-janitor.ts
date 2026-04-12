/**
 * Test-run janitor — cleans up old author test workflows.
 *
 * Both functions are safe to call concurrently: they never delete a workflow
 * whose instances are still in a non-terminal state.
 */

import type { OrchestratorDB } from '../db/database.js';
import type { WorkflowDefinition } from '../schemas/pipeline.js';

/**
 * Delete old author test workflows for a given parent, keeping only the last `keep`.
 * Safety: never deletes a workflow that has any running / waiting instance.
 * Returns the number of workflows deleted.
 *
 * listTestWorkflows returns rows in rowid (insertion) order — oldest first.
 * We keep the last `keep` entries and delete the rest.
 */
export function cleanupAuthorTestRuns(db: OrchestratorDB, parentWorkflowId: string, keep = 3): number {
  const allTestWorkflows = db.listTestWorkflows();

  // Filter to children of the given parent; order is oldest-first (rowid order)
  const children = allTestWorkflows.filter(
    (w) => (w as WorkflowDefinition).parent_workflow_id === parentWorkflowId,
  );

  // Keep the last `keep` (newest); the leading entries are candidates for deletion
  const toDelete = children.slice(0, Math.max(0, children.length - keep));
  let deleted = 0;

  for (const workflow of toDelete) {
    if (db.hasNonTerminalInstances(workflow.id)) {
      console.log(`[test-run-janitor] Skipping workflow ${workflow.id} — has running instances`);
      continue;
    }
    db.deleteWorkflow(workflow.id);
    console.log(`[test-run-janitor] Deleted test workflow ${workflow.id} (parent: ${parentWorkflowId})`);
    deleted++;
  }

  return deleted;
}

/**
 * Periodic sweep: delete any is_test=1 workflow whose instances are all terminal
 * and whose newest instance completed more than `maxAgeHours` hours ago.
 * Never deletes workflows with running instances.
 * Returns the number of workflows deleted.
 */
export function cleanupOrphanTests(db: OrchestratorDB, maxAgeHours = 24): number {
  const testWorkflows = db.listTestWorkflows();
  const cutoffMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  for (const workflow of testWorkflows) {
    // Skip if any instance is still running — uses a targeted LIMIT 1 query
    if (db.hasNonTerminalInstances(workflow.id)) {
      continue;
    }

    // Fetch instances only to determine the most recent activity timestamp
    const { data: instances } = db.listInstances({ definitionId: workflow.id, includeTest: true, limit: 200 });

    // Determine the most recent activity timestamp across all instances
    let latestMs = 0;
    for (const inst of instances) {
      const ts = inst.completed_at ?? inst.updated_at ?? inst.created_at;
      const ms = new Date(ts).getTime();
      if (ms > latestMs) latestMs = ms;
    }

    // A test workflow with no instances at all is treated as orphaned (latestMs stays 0)
    if (instances.length > 0 && now - latestMs < cutoffMs) {
      continue;
    }

    db.deleteWorkflow(workflow.id);
    console.log(`[test-run-janitor] Deleted orphan test workflow ${workflow.id}`);
    deleted++;
  }

  return deleted;
}
