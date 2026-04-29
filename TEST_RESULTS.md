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
| D1–D6 | 3 | Data flow | ⏭ | Deferred — pick up next session. |
| G1–G8 | 4 | Gates & approvals | ⏭ | Deferred. |

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

---

## Coverage progression

- **Tier 1 (smoke):** 5/5 ✅
- **Tier 2 (triggers):** 4/5 ✅, 1 partial (T5)
- **Tier 3 (data flow):** deferred
- **Tier 4 (gates & approvals):** deferred

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
