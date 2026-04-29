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
| T5 | 2 | Code-trigger fires | ⚠ partial | Activates; child emits 1 event (`eventCount:1`); but child exits with code 13 ("unsettled top-level await") and instance is wrongly tagged `initiated_by='cron'`. See B5 + B6. |
| D1 | 3 | Edge `prompt_template` resolves `{{ output.* }}` | ✅ | trigger → code-exec(typed) → agent. `{{ output.count }}`, `{{ output.label }}`, `{{ output.items \| join(",") }}` all substituted correctly. |
| D2 | 3 | Gate passthrough downstream | ✅ | producer → auto-gate → consumer. Gate output is `{approved:true, input: <upstream>}` exactly as documented. |
| D3 | 3 | Fan-in: 2 upstreams → 1 downstream | ❌ | **Bug B9** — default `input_mode:queue` runs target N times (one per edge). Even with explicit `input_mode:fan_in`, only one edge's template renders and field refs resolve to empty. |
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
- **Severity:** Cosmetic / observability. Webhook activations succeed (the route exists and accepts POSTs), but the trigger status reporting is empty for them. Cron and code-trigger DO show status. Suggests webhook is intentionally treated as passive (no daemon → no lifecycle row), but that distinction isn't documented in the API.
- **Status:** noted, no fix yet — verify whether intentional.

### B5 — Code-trigger fires but instance is tagged `initiated_by='cron'`

- **Discovered:** T5
- **Severity:** Lineage tracking is wrong; downstream `list_runs(initiatedBy='cron')` filters return code-triggered instances.
- **Repro:** activate a workflow with `code-trigger` that emits one event → check the resulting instance's `initiated_by`.
- **Observed:** `initiated_by="cron"`. Expected `code` (or at least not `cron`).
- **Cause:** the `InitiatedBy` enum in `src/types/instance.ts` likely is `'user' | 'author' | 'webhook' | 'cron'` — no `'code'` member. Migration 019 created the column with the same constraint. Code-trigger fires probably default to `cron` or fall through to whichever non-user path is wired.
- **Status:** open — needs investigation in next session.

### B6 — Code-trigger child exits with code 13 ("unsettled top-level await")

- **Discovered:** T5
- **Severity:** Functional. Child emits one event but then dies; if a code-trigger needs to keep emitting (the typical use case), it stays dead.
- **Repro:** activate a workflow whose code-trigger calls `await new Promise(r => signal.addEventListener("abort", r))` to wait for shutdown.
- **Observed:** Node logs "Detected unsettled top-level await" and exits with code 13. `eventCount=1, errorCount=1`.
- **Cause:** the code-trigger wrapper at `T_wrapper.mjs:14` does `await userFn(...)`. When the user fn returns a never-resolving promise (the typical "wait for abort" pattern), Node interprets it as a top-level await that won't settle. Should the wrapper instead loop on AbortController?
- **Status:** open — needs investigation.

### B7 — Webhook response uses `instance_id`, manual trigger response uses `id` (cosmetic)

- **Discovered:** T3
- **Severity:** Cosmetic — minor API inconsistency.
- **Recommendation:** normalize to `instanceId` (camelCase) or at least one field name across both endpoints.
- **Status:** open — flag for API hygiene pass.

### B8 — Code-executor sandbox blocks tsx loader

- **Discovered:** D1
- **Severity:** Blocks any code-executor stage that uses sandbox=true (the default).
- **Repro:** Trigger any workflow with a sandboxed code-executor.
- **Observed:** Stage fails with `ERR_ACCESS_DENIED` reading `/Users/brian/vibe/autome2/node_modules/tsx/package.json` because Node's `--permission --allow-fs-read=<workspace>` only whitelists the workspace dir.
- **Cause:** the wrapper that runs user code uses `tsx/esm` to support TypeScript imports, but the loader needs to read its own package.json from the project's `node_modules`. Permission model doesn't allow that path.
- **Workaround:** set `sandbox: false` in code-executor config.
- **Fix direction:** add the autome install dir's `node_modules` to `--allow-fs-read` (read-only), or pre-bundle the user code so tsx isn't needed at runtime.
- **Status:** open.

### B9 — Fan-in (multiple incoming edges into one stage) is broken

- **Discovered:** D3
- **Severity:** High — multi-stage workflows with parallel branches don't merge correctly.
- **Repro 9.1:** trigger → A and B (parallel) → C (no `input_mode` set). Both A and B complete in parallel, then C runs **twice** (`run_count: 2`), once with A's input and once with B's. Each iteration only has one source's data.
- **Repro 9.2:** Same fixture but with `input_mode: 'fan_in'`, `trigger_rule: 'all_success'` on C. C correctly runs once (`run_count: 1`), but only one of the two incoming edges' `prompt_template` is rendered, and `{{ output.* }}` references inside it resolve to empty (because in fan-in mode, the template scope changes — input becomes keyed by source-id `{a:..., b:...}`, but the docs/UX still suggest `{{ output.* }}` works).
- **Cause:** Two-part — the engine's default `input_mode:queue` is wrong for fan-in semantics, AND the template rendering for fan-in mode isn't merging or reaching the keyed inputs.
- **Status:** open — needs design discussion. The `input_mode:queue` default may be intentional for queue/streaming workloads, but the docs and seed examples (Jira workflow has multi-upstream `code-reviewer → code-gen` revise loop) all assume fan-in.

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
- **Tier 2 (triggers):** 4/5 ✅, 1 partial (T5)
- **Tier 3 (data flow):** 5/6 ✅, 1 fail (D3 / B9)
- **Tier 4 (gates & approvals):** 6/8 ✅ (G7 review-gate, G8 timeout deferred). G4 was failing pre-fix; B10 patched in this session, re-verified ✅.

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
