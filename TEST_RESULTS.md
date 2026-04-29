# autome2 Hardening Test Results

Branch: `feat/test-hardening`
Started: 2026-04-28

## Status

| ID | Tier | Test | Status | Notes |
|----|------|------|--------|-------|
| S1 | 1 | App boots cold (`npm run dev:all`) | ✅ | Both servers reachable; healthy startup. |
| S2 | 1 | `/` workflows list loads | ✅ | All 3 seeded workflows render after seed fix. |
| S3 | 1 | Empty workflow round-trips via API | ✅ | Validation correctly rejects truly empty (no trigger stage); minimal valid workflow round-trips clean. |
| S4 | 1 | "Simple Analysis" runs to completion | ✅ | Agent runs to `completed`. Surfaced template bug B3 (see below). |
| S5 | 1 | DB migrations apply | ✅ | 25 migrations recorded in `_migrations`. |
| T1 | 2 | Manual trigger lands payload at first stage | ✅ | `context.trigger == triggerEvent.payload` (verified by S4 inspection). |
| T2 | 2 | Prompt trigger | ✅ | Built fixture; `{{ trigger.prompt }}` substituted in agent prompt. Cleaned up. |
| T3 | 2 | Webhook trigger | ✅ | `POST /api/webhooks/:workflowId` → instance with `initiated_by='webhook'`, payload + source IP captured. |
| T4 | 2 | Cron trigger fires | ✅ | 30s schedule fires, instance has `initiated_by='cron'`. |
| T5 | 2 | Code-trigger fires | ✅ | Was failing (B5 + B6); both patched. Child stays alive past first emit; instance correctly tagged `initiated_by='code'`. |
| D1 | 3 | Edge `prompt_template` resolves `{{ output.* }}` | ✅ | trigger → code-exec(typed) → agent. `{{ output.count }}`, `{{ output.label }}`, `{{ output.items \| join(",") }}` all substituted correctly. |
| D2 | 3 | Gate passthrough downstream | ✅ | producer → auto-gate → consumer. Gate output is `{approved:true, input: <upstream>}` exactly as documented. |
| D3 | 3 | Fan-in: 2 upstreams → 1 downstream | ✅ | With `input_mode:'fan_in'` set on the target stage, all incoming edges' `prompt_template`s now render and concatenate. **B9.2** patched — `buildAgentPrompt` reads incoming edges from the definition rather than relying on a singular `incomingEdge` arg. Default `input_mode:'queue'` is intentional for branch/loop edges (see B9 entry below). |
| D4 | 3 | Code-executor typed output | ✅ | Output exactly matches declared `output_schema`; downstream sees the right shape. (Discovered B8 — sandbox issue.) |
| D5 | 3 | Conditional edge — passing predicate | ✅ | `condition: "output.x > 0"` with x=5 → branch fires. |
| D6 | 3 | Conditional edge — failing predicate | ✅ | x=-3 → branch doesn't fire (stays `pending`, not `skipped` — minor observability note). |
| G1 | 4 | Manual gate pauses | ✅ | instance status `waiting_gate`; gate stage `running`; downstream `pending`. |
| G2 | 4 | `/api/approvals` shows rendered template | ✅ | `"Please approve {{ input.item }} priced at {{ input.price }}"` → `"Please approve widget-42 priced at 99"`. |
| G3 | 4 | GateSidebar (UI) shows rendered template | ✅ | playwright-cli verified `"Buy {{ input.item }} for $ {{ input.price }}?"` → `"Buy monitor for $ 350?"` in the sidebar. |
| G4 | 4 | Approve resumes; downstream sees edited data | ✅ | Was failing (B10); fixed in this session — gate executor now honors `result.data` when present. End-to-end re-verified: edits reach downstream consumer. |
| G5 | 4 | Reject terminates | ✅ | Instance `failed`; gate error reads `Gate "the-gate" was rejected`; consumer never runs. |
| G6 | 4 | Conditional gate fail terminates | ✅ | `condition: "input.ok === true"` with `ok:false` → instance `failed`, downstream `pending`. |
| G7 | 4 | Review gate paths | ⏭ | Deferred — needs review-gate fixture + 3 decision branches. |
| G8 | 4 | Gate timeout fires | ⏭ | Deferred — slow (≥1 min wait). |

Legend: ⬜ pending · 🟡 in progress · ✅ pass · ⚠ partial · ❌ fail · ⏭ deferred

---

## Bugs found

### B1 — Seed script broken (stale DB API)

- **Discovered:** Tier 1 setup
- **Severity:** Blocks fresh-install onboarding (`npm run seed` is the canonical fixture path)
- **Repro:** `npm run seed` on a fresh DB
- **Observed:** `TypeError: db.listPipelines is not a function`
- **Cause:** `db.listPipelines()` and `db.createPipeline()` were renamed to `listWorkflows` / `createWorkflow` (also `listWorkflows` returns `{data, total}` not a bare array)
- **Fix:** updated `scripts/seed.ts` (uncommitted)
- **Status:** patched ✅

### B2 — Seed references non-existent agents

- **Discovered:** S4
- **Severity:** Seed runs but downstream stages fail because the agents don't exist
- **Repro:** seed → trigger any seed workflow → agent stage cannot find `requirements-analyst`/`code-generator`/`code-reviewer`/`pr-publisher`
- **Cause:** Stale agent IDs from a pre-cleanup era. Available agents are `assistant`, `generalist`, `implementer`, `infra`, `orchestrator`, `researcher`, `reviewer`, `skill-writer`, `test-runner`, `workflow-author`.
- **Fix:** remapped seeds to existing agents (`generalist`, `researcher`, `implementer`, `reviewer`)
- **Status:** patched ✅

### B3 — Seed edge templates use non-existent path `{{ trigger.payload }}`

- **Discovered:** S4 (rendered prompt analysis)
- **Severity:** Latent / silent. Agents in seed workflows received empty prompts; they only succeeded because they fetched context via tools.
- **Repro:** Trigger any seed workflow with payload `{text: "..."}`. Read the rendered prompt — `{{ trigger.payload }}` resolves to empty.
- **Cause:** `initializeContext` in `src/engine/graph-helpers.ts:45` sets `context.trigger = triggerEvent.payload` directly. So `trigger.text` works; `trigger.payload` does not (no nested `payload` field).
- **Fix:** changed seed templates to `{{ trigger | dump }}` (nunjucks built-in JSON serializer). Verified the agent now sees the full payload.
- **Status:** patched ✅
- **Latent runtime concern:** nunjucks env has `throwOnUndefined: false` so any typo or stale field reference silently renders empty. Worth a future "dry-run lint" pass that warns when a template references a path absent from the resolved mock context.

### B4 — `/api/workflows/:id/triggers` returns `{}` for activated webhook workflows

- **Discovered:** T3 setup
- **Severity:** Cosmetic / observability.
- **Resolution:** by-design. The `/triggers` endpoint reports lifecycle-managed triggers (cron, code) only. Webhooks are passive HTTP routes — no daemon, no lifecycle row. The endpoint route at `src/api/routes/triggers.ts` reads `getWorkflowTriggerStatuses` which only tracks active long-running triggers. Webhook URLs can be derived from `POST /api/webhooks/:workflowId`. Future enhancement: surface webhook URLs via a separate field in the same response if the docs need it, but no functional bug.
- **Status:** **closed — by-design**.

### B5 — Code-trigger fires but instance is tagged `initiated_by='cron'`

- **Discovered:** T5
- **Severity:** Lineage tracking is wrong; downstream `list_runs(initiatedBy='cron')` filters return code-triggered instances.
- **Repro:** activate a workflow with `code-trigger` that emits one event → check the resulting instance's `initiated_by`.
- **Observed:** `initiated_by="cron"`. Expected `code` (or at least not `cron`).
- **Cause:** confirmed — `InitiatedBy` had no `'code'` member, AND the eventBus listener in `server-start.ts` hardcoded `initiatedBy: 'cron'` for every event-bus-driven trigger fire (regardless of provider).
- **Status:** **patched ✅** — added `'code'` to the enum + zod schema, replaced the hardcoded value with a `provider → initiated_by` map. End-to-end re-verified: code-trigger fire now stamps `initiated_by: 'code'`. No migration needed (`019_instance_lineage.sql` has no CHECK constraint).

### B6 — Code-trigger child exits with code 13 ("unsettled top-level await")

- **Discovered:** T5
- **Severity:** Functional. Child emits one event but then dies; if a code-trigger needs to keep emitting (the typical use case), it stays dead.
- **Repro:** activate a workflow whose code-trigger calls `await new Promise(r => signal.addEventListener("abort", r))` to wait for shutdown.
- **Observed:** Node logs "Detected unsettled top-level await" and exits with code 13. `eventCount=1, errorCount=1`.
- **Cause:** confirmed — top-level `await userFn(...)` in the wrapper. Node 24's "unsettled top-level await" detector exits with code 13 once the user fn awaits its abort promise.
- **Status:** **patched ✅** — wrapper rewritten in `src/nodes/builtin/code-trigger.ts:buildWrapperScript`. No top-level await; user fn is called and any rejection is caught + logged; a `setInterval` keepalive holds the event loop open until SIGTERM/SIGINT triggers orderly shutdown. Re-verified: trigger state transitions from `errored` → `active`, `errorCount` 1 → 0.

### B7 — Webhook response uses `instance_id`, manual trigger response uses `id` (cosmetic)

- **Discovered:** T3
- **Severity:** Cosmetic — minor API inconsistency.
- **Status:** **patched ✅** — webhook endpoint now returns `id` to match the manual trigger response. No callers consumed the old `instance_id` field, so no client-side updates needed.

### B8 — Code-executor sandbox blocks tsx loader

- **Discovered:** D1
- **Severity:** Blocks any code-executor stage that uses sandbox=true (the default).
- **Repro:** Trigger any workflow with a sandboxed code-executor.
- **Observed:** Stage fails with `ERR_ACCESS_DENIED` reading `/Users/brian/vibe/autome2/node_modules/tsx/package.json` because Node's `--permission --allow-fs-read=<workspace>` only whitelists the workspace dir.
- **Cause:** the wrapper that runs user code uses `tsx/esm` to support TypeScript imports, but the loader needs to read its own package.json from the project's `node_modules`. Permission model doesn't allow that path.
- **Status:** **patched ✅** — required deeper changes than expected:
  1. Switched from `--import tsx/esm` to `--require tsx/cjs` in sandbox mode. Node 24's permission model does not propagate `--allow-fs-read` grants into worker threads, and `tsx/esm` spawns a worker for its loader hook. `tsx/cjs` does the transform synchronously without worker threads.
  2. Loosened `--allow-fs-read=${workspace.root}` to `--allow-fs-read=/`. tsx's tsconfig discovery probes case-inverted paths via `get-tsconfig`'s `isFsCaseSensitive` heuristic — those paths can't be predicted and the grant must be unrestricted. Read-only access only; writes, child_process, and worker_threads remain denied.
  3. Set `TSX_DISABLE_CACHE=1` to stop tsx's on-disk cache from `mkdir`-ing in the OS temp dir (denied by `--permission` with no fs-write grant).
- **Trade-off documented:** the sandbox now has effectively no read isolation but retains write/spawn/worker isolation. A negative test confirmed `writeFileSync` is still blocked: `Error: Access to this API has been restricted. Use --allow-fs-write to manage permissions.`

### B9 — Fan-in (multiple incoming edges into one stage) is broken

- **Discovered:** D3
- **Severity:** High — multi-stage workflows with parallel branches don't merge correctly.
- **Repro 9.1:** trigger → A and B (parallel) → C (no `input_mode` set). Both A and B complete in parallel, then C runs **twice** (`run_count: 2`), once with A's input and once with B's. Each iteration only has one source's data.
- **Repro 9.2:** Same fixture but with `input_mode: 'fan_in'`, `trigger_rule: 'all_success'` on C. C correctly runs once (`run_count: 1`), but only one of the two incoming edges' `prompt_template` is rendered, and `{{ output.* }}` references inside it resolve to empty (because in fan-in mode, the template scope changes — input becomes keyed by source-id `{a:..., b:...}`, but the docs/UX still suggest `{{ output.* }}` works).
- **Cause:** confirmed — two distinct issues.
- **Status:**
  - **B9.1 (default `input_mode:'queue'`):** **closed — by-design.** On reflection, queue is the right default for the most common multi-upstream pattern: branch/loop edges (e.g., the Jira workflow's `code-reviewer revise → code-gen` loop). Either-or branches and revise-loops genuinely want each incoming edge to fire the target independently. Fan-in semantics ("wait for ALL upstreams") only fit truly parallel computations and need explicit opt-in via `input_mode:'fan_in'` on the target stage.
  - **B9.2 (fan_in only renders one edge's template):** **patched ✅** — `buildAgentPrompt` in `src/engine/context-resolver.ts` now reads incoming success edges from the workflow definition and renders each edge's `prompt_template` against THAT edge's source output. Renderings are joined with `\n\n`. 6 new unit tests cover the fan-in branch (single edge, multi edge, missing template, no templates, missing source, etc.). Smoke test: agent C (fan_in target) ran exactly once and saw both `From A: a_value=100, a_label=from-A` AND `From B: b_value=200, b_label=from-B` in its prompt.

### B10 — Approve body's `data` field is silently dropped

- **Discovered:** G4
- **Severity:** High — UX lies. The approval UI lets users edit upstream data before approving (`GateSidebar.tsx` and the `/approvals` ApprovalCard both have a "Data to approve" textarea), but the gate executor ignores `result.data` and emits the original `passthrough`.
- **Repro:** trigger workflow with manual gate. POST `/api/instances/:id/gates/:stageId/approve` with `{data:{item:"EDITED",price:9999}}`. Downstream stage receives the original upstream output, not the edited version.
- **Cause:** `src/nodes/builtin/gate.ts` line ~46: `return { output: { approved: true, input: passthrough } }` — `result.data` is not consulted. The `resolveWait` payload includes `{approved, data}` but the executor types `raw` as `{approved} | boolean` and never reads `data`.
- **Fix sketch:** `const finalInput = result.data !== undefined ? result.data : passthrough; return { output: { approved: true, input: finalInput } };`
- **Status:** **patched ✅** — gate executor now uses `result.data` when present, falling back to `passthrough` when undefined. 16 unit tests pass (was 14). End-to-end re-verified.

---

## Coverage progression

- **Tier 1 (smoke):** 5/5 ✅
- **Tier 2 (triggers):** 5/5 ✅ (T5 was partial, B5+B6 fixed → ✅)
- **Tier 3 (data flow):** 6/6 ✅ (D3 was failing, B9.2 patched → ✅)
- **Tier 4 (gates & approvals):** 6/8 ✅ (G7 review-gate, G8 timeout deferred). G4 was failing pre-fix; B10 patched and re-verified ✅.

## Bugs ledger

| # | Bug | Status |
|---|-----|--------|
| B1 | Seed used renamed DB methods | Patched ✅ |
| B2 | Seed referenced non-existent agents | Patched ✅ |
| B3 | Seed templates used `{{ trigger.payload }}` | Patched ✅ |
| B4 | `/triggers` returns `{}` for webhook | By-design — closed |
| B5 | Code-trigger instance tagged `cron` | Patched ✅ |
| B6 | Code-trigger child exits with code 13 | Patched ✅ |
| B7 | Webhook response shape inconsistency | Patched ✅ |
| B8 | Code-executor sandbox blocks tsx | Patched ✅ |
| B9.1 | Default `input_mode:'queue'` for multi-upstream | By-design — closed |
| B9.2 | `fan_in` mode only renders one edge's template | Patched ✅ |
| B10 | Approve body's `data` silently dropped | Patched ✅ |

## Operational notes

- Dev DB at `/Users/brian/vibe/autome2/data/orchestrator.db` carries 50+ stale failed instances from earlier dev sessions (`query: "stock prices"` etc.) — clutter, not blocking.
- Three legit smoke instances completed successfully during testing (manual + webhook seed flows).
- All test fixtures created during the run were cleaned up.

## Next session — pickup

1. Resume on `feat/test-hardening`.
2. Boot dev stack (`npm run dev:all`), verify seed workflows still present (`curl /api/workflows | jq '.data[].name'`).
3. Tier 3 D1–D6 — focus on edge templates, gate passthrough, fan-in.
4. Tier 4 G1–G8 — gates pause/resume, message rendering, conditional branches.
5. Loop back on B5+B6 (code-trigger lineage + wrapper bug) when there's appetite.
