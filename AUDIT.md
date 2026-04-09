# Autome2 System Audit

**Date:** 2026-04-09
**Scope:** Full codebase — backend, frontend, types, database, engine, Restate integration
**Test Results:** 428 passed, 6 skipped, 0 failed

### Resolution Status

| ID | Status | Commit |
|---|---|---|
| CRIT-1 | ✅ Fixed | `45974c9` — UUID validation before SQL interpolation |
| CRIT-2 | ✅ Fixed | `6beb8b6` — executeMapStage now uses Promise.all for batch parallelism |
| CRIT-3 | ✅ Fixed | `6beb8b6` — Removed non-deterministic new Date() fallback |
| CRIT-4 | ✅ Fixed | `6beb8b6` — propagateSkip now syncs to DB |
| CRIT-5 | ✅ Fixed | `f8b1d11` — definition_id nullable in Drizzle schema + Zod |
| CRIT-6 | ✅ Fixed | `6beb8b6` — __fired sentinel prevents fan-in double-trigger |
| CRIT-7 | ✅ Fixed | `e592c3b` — Separated nested setState into sequential updates |
| HIGH-1 | ✅ Fixed | `6beb8b6` — syncContextToDb throws on error for Restate retry |
| HIGH-2 | ✅ Fixed | `a89ac90` — signalledStages cleaned on workflow-finished |
| HIGH-3 | ✅ Fixed | `f8b1d11` — deleteInstance wrapped in transaction |
| HIGH-4 | ✅ Fixed | `f8b1d11` — migrateAuthorSegments wrapped in transaction |
| HIGH-5 | ✅ Fixed | `a89ac90` — Graph validation runs when edges-only update |
| HIGH-6 | ✅ Fixed | `a89ac90` — DELETE returns 404 for non-existent workflows |
| HIGH-7 | ✅ Fixed | `a89ac90` — code-trigger uses actual workflow version |
| HIGH-8 | ✅ Fixed | `a89ac90` — Explicit null guard in agent executor |
| HIGH-9 | ✅ Fixed | `a89ac90` — Removed phantom ToolCallRecord fields |
| HIGH-10 | Open | cancelWorkflow returns success even on failure |
| HIGH-11 | ✅ Fixed | `e592c3b` — Optional chaining on spec?.color?.bg |
| HIGH-12 | ✅ Fixed | `e592c3b` — WebSocket handler cleanup per instance |
| HIGH-13 | ✅ Fixed | `6beb8b6` — executeMapStage handles empty arrays |

---

## Table of Contents

1. [Critical Issues](#critical-issues)
2. [High Priority Issues](#high-priority-issues)
3. [Medium Priority Issues](#medium-priority-issues)
4. [Low Priority / Suggestions](#low-priority--suggestions)
5. [Test Coverage Report](#test-coverage-report)
6. [Code Quality & Duplication](#code-quality--duplication)

---

## Critical Issues

### CRIT-1: SQL Injection in `cancelWorkflow`
- **File:** `src/restate/client.ts:63`
- **Category:** security
- `instanceId` is interpolated directly into a SQL string for the Restate admin query. If the ID contains SQL metacharacters, it could leak data or cause unexpected behavior.
- **Fix:** Validate `instanceId` matches UUID pattern before interpolation, or use parameterized queries if Restate supports them.

### CRIT-2: `executeMapStage` runs items sequentially despite `concurrency` setting
- **File:** `src/restate/stage-executor.ts:336-411`
- **Category:** bug
- The inner loop uses `await` per item — items are processed serially regardless of `concurrency`. The `concurrency` property has no effect.
- **Fix:** Use `Promise.all` over each batch slice to actually parallelize.

### CRIT-3: Non-deterministic `new Date()` outside `ctx.run` on Restate replay path
- **File:** `src/restate/graph-helpers.ts:16`
- **Category:** bug (Restate anti-pattern)
- `initializeContext` falls back to `new Date().toISOString()` when trigger has no timestamp. This is called directly in the workflow `run` handler outside `ctx.run`. On journal replay, it produces a different value, causing a journal mismatch error.
- **Fix:** Always require `triggerEvent.timestamp`, or wrap the fallback in `ctx.run`.

### CRIT-4: `propagateSkip` never syncs to DB
- **File:** `src/restate/stage-executor.ts:101-147`
- **Category:** bug
- Skipped stages update Restate state (`ctx.set`) but never call `syncContextToDb`. The DB and UI show skipped stages as `pending` indefinitely.
- **Fix:** Add `syncContextToDb` call after marking stages as skipped.

### CRIT-5: `definition_id` type mismatch — schema says non-nullable, DB allows NULL
- **File:** `src/types/instance.ts:76`, `src/db/database.ts:378,428`
- **Category:** bug
- `WorkflowInstanceSchema` declares `definition_id: z.string()` but the DB column is nullable (migration 015). When a workflow is deleted, instances have `null` definition_id. `getInstanceDefinition` passes `null` to queries with no guard, causing silent failures.
- **Fix:** Change to `z.string().nullable()`, add null guard in `getInstanceDefinition`.

### CRIT-6: `recordFanInCompletion` fires fan-in stage multiple times with `any_success`
- **File:** `src/restate/graph-helpers.ts:126-129`
- **Category:** bug
- When `trigger_rule` is `any_success`, the function returns merged inputs on every call after the first upstream succeeds. Each subsequent upstream completion re-triggers the fan-in stage.
- **Fix:** Add a "has already fired" flag to fan-in state to prevent re-triggering.

### CRIT-7: `appendToolSegment` calls setState inside another setState updater
- **File:** `frontend/src/hooks/useChatMessages.ts:107-124`
- **Category:** bug
- Calls `setMessages` from inside `setStreamingText` updater — prohibited in React 18 concurrent mode. Can cause dropped updates or double-flush.
- **Fix:** Separate the two state updates; flush streaming text before appending tool segment.

---

## High Priority Issues

### HIGH-1: `syncContextToDb` swallows HTTP errors
- **File:** `src/restate/stage-executor.ts:80-90`
- **Category:** bug
- `.catch()` logs but returns `{ synced: true }` regardless. Restate never retries failed syncs, causing permanent DB/Restate divergence.
- **Fix:** Re-throw after logging so Restate retries the step.

### HIGH-2: `signalledStages` memory leak
- **File:** `src/api/routes/internal-restate.ts:100,108,408`
- **Category:** bug
- Stage keys are added on completion but only removed on kill/restart. Grows unbounded over time.
- **Fix:** Clean up keys in the `workflow-finished` handler.

### HIGH-3: `deleteInstance` not atomic
- **File:** `src/db/database.ts:368-373`
- **Category:** bug
- Four DELETE statements with no transaction. Crash between them leaves orphaned data.
- **Fix:** Wrap in `this.db.transaction(() => { ... })()`.

### HIGH-4: `migrateAuthorSegments` not atomic
- **File:** `src/db/database.ts:662-669`
- **Category:** bug
- Two UPDATE statements without transaction. Crash leaves segments and tool_calls with mismatched stage_ids.
- **Fix:** Wrap in transaction.

### HIGH-5: `PUT /api/workflows/:id` skips graph validation when only edges updated
- **File:** `src/api/routes/workflows.ts:143-166`
- **Category:** bug
- Graph validation only runs when `body.stages` is present. Updating only `edges` skips validation — can persist edges referencing non-existent stages.
- **Fix:** Validate when either `stages` or `edges` is updated.

### HIGH-6: `DELETE /api/workflows/:id` returns 204 for non-existent workflows
- **File:** `src/api/routes/workflows.ts:183-233`
- **Category:** quality
- Should return 404 when the workflow doesn't exist.

### HIGH-7: `code-trigger` hardcodes workspace version `1`
- **File:** `src/nodes/builtin/code-trigger.ts:58`
- **Category:** bug
- Uses `ensureWorkspace(workflowId, 1, deps)` instead of the actual workflow version. Dependency changes in newer versions are ignored.
- **Fix:** Pass workflow version through to the activate call.

### HIGH-8: Non-null assertion on `stage` in agent executor
- **File:** `src/nodes/builtin/agent.ts:23`
- **Category:** bug
- `stage!` asserted without guard. If definition is desynchronized during Restate replay, crashes with confusing error.
- **Fix:** Add explicit null check with `TerminalError`.

### HIGH-9: `ToolCallRecordSchema` has phantom fields not in DB
- **File:** `src/types/instance.ts:95-117`
- **Category:** bug/quality
- `permission_status`, `permission_options`, `exit_code` fields exist in the Zod schema but no corresponding DB columns exist. Code accessing these fields from DB results always gets `undefined`.
- **Fix:** Add migration for the columns, or remove from schema.

### HIGH-10: `cancelWorkflow` returns success even on failure
- **File:** `src/restate/client.ts:55-89`
- **Category:** quality
- Returns `{ cancelled: true }` even when both cancellation paths fail.

### HIGH-11: Frontend `spec?.color.bg` crashes when spec is undefined
- **File:** `frontend/src/components/canvas/WorkflowCanvas.tsx:204`
- **Category:** bug
- `spec?.color.bg` — `spec?.color` returns `undefined`, then `.bg` throws.
- **Fix:** Use `spec?.color?.bg`.

### HIGH-12: WebSocket singleton has stale handler risk in React Strict Mode
- **File:** `frontend/src/hooks/useWebSocket.ts:16-18`
- **Category:** bug
- Module-level mutable globals (`handlers`, `ws`, `queryClientRef`) can retain stale subscriptions during HMR or Strict Mode double-invocation.

### HIGH-13: `executeMapStage` doesn't handle empty arrays
- **File:** `src/restate/stage-executor.ts:333-420`
- **Category:** bug
- Empty `items` array means the loop never executes — stage status stays `pending`, `latest` is never set, downstream stages get `null`.
- **Fix:** Handle `items.length === 0` explicitly.

---

## Medium Priority Issues

### MED-1: `getDraft` silently creates empty drafts for non-existent IDs
- **File:** `src/api/routes/shared.ts:100-123`
- **Category:** quality
- Returns 200 with empty data instead of 404. Impossible for clients to distinguish "empty" from "doesn't exist."

### MED-2: Upload routes have no size limit
- **File:** `src/api/routes/workflows.ts:443-495`
- **Category:** security
- Import/preview routes buffer entire upload with no size cap. Large uploads can exhaust memory.

### MED-3: Dual `WorkflowDefinition` type sources
- **File:** `src/schemas/pipeline.ts` vs `src/types/workflow.ts`
- **Category:** quality
- Two parallel type definitions create drift risk.

### MED-4: `ctx.set` called per-item in map loops
- **File:** `src/restate/stage-executor.ts` (multiple lines)
- **Category:** performance
- Generates O(N) Restate journal entries per map iteration. Should batch per-batch, not per-item.

### MED-5: `cleanupOldVersions` exported but never called
- **File:** `src/nodes/workspace-manager.ts:175-192`
- **Category:** dead-code
- Old versioned workspaces accumulate on disk indefinitely.

### MED-6: CodeEditor linter requests race without AbortController
- **File:** `frontend/src/components/canvas/CodeEditor.tsx:239,329`
- **Category:** bug
- Async linter fires on each keystroke. Slow old responses can overwrite newer results.

### MED-7: Webhook secret shown in plaintext in ConfigPanel
- **File:** `frontend/src/components/canvas/ConfigPanel.tsx:456`
- **Category:** security
- Curl example renders raw secret. `TriggerSidebar` correctly masks it.

### MED-8: Missing React error boundaries on canvas components
- **File:** `frontend/src/components/canvas/WorkflowCanvas.tsx`
- **Category:** quality
- Runtime errors in `buildNodes` crash the entire page with a blank screen.

### MED-9: `forceStoppedStages` race condition
- **File:** `src/api/routes/internal-restate.ts:357-360`, `instances.ts:472-473`
- **Category:** bug
- If cancelled agent emits multiple `turn_end` events, only the first is suppressed — subsequent ones fire unwanted nudges.

### MED-10: `WorkflowCanvas` `useEffect` missing `isAuthor` dependency
- **File:** `frontend/src/components/canvas/WorkflowCanvas.tsx:512`
- **Category:** bug
- Mode change from `runtime` to `author` won't re-render node callbacks.

---

## Low Priority / Suggestions

| # | File | Issue |
|---|---|---|
| LOW-1 | `src/config.ts:16` | No validation on PORT parsing — `NaN` causes confusing bind error |
| LOW-2 | `src/nodes/builtin/code-executor.ts:108` | Icon is emoji `'⚡'` while all others use Lucide names |
| LOW-3 | `src/nodes/builtin/cron-trigger.ts:23` | Cron regex requires trailing space; `"*/10"` alone fails silently |
| LOW-4 | `frontend/src/components/canvas/ConfigPanel.tsx:43` | `setTimeout` for copy state not cleaned up on unmount |
| LOW-5 | `frontend/src/lib/nodeRegistry.ts:8` | `code-trigger` in `UI_GROUP_MAP` but not in `NODE_TYPE_MAP` — dead entry |
| LOW-6 | `frontend/src/routes/instances.tsx:202` | `confirm()` dialog inconsistent with custom ConfirmModal elsewhere |
| LOW-7 | `frontend/src/components/canvas/WorkflowCanvas.tsx:689` | `Math.max(...nodes.map())` — stack overflow risk on large arrays |
| LOW-8 | `src/types/instance.ts:191-192` | `AgentSpec`/`CanonicalAgentSpec` redundant aliases |
| LOW-9 | `frontend/src/components/instance/RunHistory.tsx:239` | Array index as React key; should use `run.iteration` |
| LOW-10 | `frontend/src/hooks/useKeyboardShortcuts.ts` | `isMac` exported from hook file; should be in `lib/platform.ts` |
| SUGG-1 | `frontend/src/components/canvas/CodeEditor.tsx:228` | `validateFieldPath` duplicated in `EdgeConfigPanel.tsx:24` — extract to shared |
| SUGG-2 | `frontend/src/components/canvas/EdgeConfigPanel.tsx` | Output-schema lookup logic repeated 3x — extract helper |
| SUGG-3 | `frontend/src/components/instance/` | Tab bar markup duplicated in GateSidebar + GenericSidebar — extract component |
| SUGG-4 | `frontend/src/components/instance/OverviewSidebar.tsx:9` | `formatTimestamp` duplicated in RunHistory — consolidate in `lib/format.ts` |
| SUGG-5 | `frontend/src/components/canvas/SchemaForm.tsx:425` | Local `Field` component duplicates `ConfigPanelShared.tsx` export |

---

## Test Coverage Report

### Overall: 428 passed, 6 skipped, 0 failed

### Backend Test Files (22 files, 399 tests)

| File | Tests | Coverage Area |
|---|---|---|
| `src/nodes/__tests__/schema-to-zod.test.ts` | 45 | JSON schema → Zod conversion |
| `src/db/__tests__/database.test.ts` | 41 | SQLite CRUD |
| `src/restate/__tests__/workflow.test.ts` | 27 | Restate workflow state machine |
| `src/engine/__tests__/context-resolver.test.ts` | 21 | Template/variable resolution |
| `src/nodes/builtin/__tests__/code-trigger.test.ts` | 19 | Code trigger lifecycle |
| `src/nodes/custom/__tests__/loader.test.ts` | 16 | Custom node loading |
| `src/agents/__tests__/discovery.test.ts` | 12 | Agent discovery |
| `src/nodes/__tests__/registry.test.ts` | 12 | Node type registry |
| `src/api/routes/__tests__/shared-validation.test.ts` | 10 | Request validation |
| `src/mcp/__tests__/workflow-control.test.ts` | 10 | MCP tools |
| `src/events/__tests__/bus.test.ts` | 23 | Event bus |
| `src/api/__tests__/deadlock-detection.test.ts` | 4 | Deadlock detection |
| `src/nodes/builtin/__tests__/code-executor-sandbox.test.ts` | 4 | Sandbox flags |
| `packages/claude-agent-acp/src/tests/` (8 files) | 155 | ACP agent SDK |

### Frontend Test Files (3 files, 29 tests)

| File | Tests | Coverage Area |
|---|---|---|
| `frontend/src/lib/format.test.ts` | 9 | Format utilities |
| `frontend/src/hooks/useUndoRedo.test.ts` | 11 | Undo/redo |
| `frontend/src/components/canvas/SchemaForm.test.tsx` | 9 | SchemaForm rendering |

### Critical Untested Modules

| Module | Risk Level | Why It Matters |
|---|---|---|
| `src/restate/stage-executor.ts` | **Critical** | Entire execution engine — fan-out, fan-in, map, retry, cycles |
| `src/restate/graph-helpers.ts` (fan-in, skip) | **Critical** | `recordFanInCompletion`, `propagateSkip` — core graph logic |
| `src/engine/safe-eval.ts` | **High** | Sandbox bypass risk in condition evaluation |
| `src/api/routes/workflows.ts` | **High** | All workflow CRUD + trigger endpoints |
| `src/api/routes/draft.ts` | **High** | Draft editing — user data loss on bugs |
| `src/api/routes/internal-restate.ts` | **High** | Agent lifecycle, stage signaling |
| `src/workflow/launch.ts` | **High** | Workflow instance creation |
| `src/engine/trigger-lifecycle.ts` | **High** | Trigger activation/deactivation |
| `frontend/src/lib/segmentsToMessages.ts` | **High** | Complex state machine; regression corrupts chat history |
| `frontend/src/hooks/useChatMessages.ts` | **High** | Streaming state, flush logic |
| `frontend/src/hooks/useDraftLifecycle.ts` | **High** | Save/discard/blocker — regression loses user work |
| `frontend/src/hooks/useWebSocket.ts` | **High** | Reconnect, subscription cleanup |
| `src/db/database.ts` (segments, tools, drafts, settings) | **Medium** | Majority of runtime-hot DB methods untested |
| `src/bundle/export.ts`, `import.ts` | **Medium** | Bundle export/import |
| `src/api/validate-workflow.ts` | **Medium** | Workflow validation |

### Untested Critical Paths in Tested Modules

- `recordFanInCompletion` with `any_success` / `none_failed_min_one_success` trigger rules
- `evaluateEdges` with `max_traversals`
- `initializeContext` with trigger stages (test fixture has none)
- `executeWithRetry` with `max_attempts > 1` and backoff
- `drainQueuedInputs` — queue-mode accumulation
- `propagateSkip` — conditional branch skipping

---

## Code Quality & Duplication

### Duplicate Code Patterns

1. **`validateFieldPath`** — identical in `CodeEditor.tsx:228` and `EdgeConfigPanel.tsx:24`
2. **Output schema lookup** — repeated 3x in `EdgeConfigPanel.tsx`, also in `ConfigPanel.tsx` and `CodeEditor.tsx`
3. **Tab bar markup** — copy-pasted between `GateSidebar.tsx` and `GenericSidebar.tsx`
4. **`formatTimestamp`** — duplicated in `OverviewSidebar.tsx` and `RunHistory.tsx` with different implementations
5. **Output schema `CodeEditor` block** — copy-pasted between manual-trigger and webhook-trigger sections in `ConfigPanel.tsx`
6. **`Field` component** — defined in both `SchemaForm.tsx` and `ConfigPanelShared.tsx`

### Dead Code

1. `cleanupOldVersions` in `workspace-manager.ts` — exported, never called
2. `definition_snapshot` column — intentionally left but unused since migration 011
3. `code-trigger` entry in `UI_GROUP_MAP` in `nodeRegistry.ts` — not in `NODE_TYPE_MAP`
4. `AgentSpec`/`AgentSpecSchema` type aliases — redundant with `CanonicalAgentSpec`

### Architecture Notes

- **Single source of truth for types needed:** `schemas/pipeline.ts` and `types/workflow.ts` both define `WorkflowDefinition`
- **Restate determinism:** Any code in the workflow `run` handler outside `ctx.run` must be deterministic. Current violations: `new Date()` in `initializeContext`
- **DB transactions:** `deleteInstance` and `migrateAuthorSegments` lack transactions despite multi-statement writes
- **Error swallowing:** `syncContextToDb` catches and ignores HTTP errors, preventing Restate retry
