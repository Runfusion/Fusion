# Research Hardening Preflight Baseline (FN-2999)

Date: 2026-05-04  
Task: FN-3266

## Scope and intent

This document is the verified baseline for FN-2999 hardening work. It reflects **shipped behavior in-repo** and explicitly calls out drift from older assumptions.

## 1) Verified module map (Research vs Insights)

### Core (`@fusion/core`)
- `packages/core/src/research-types.ts`
  - Canonical research statuses/types/lifecycle contracts.
- `packages/core/src/research-store.ts`
  - Persistence-backed run lifecycle, transitions, cancellation request, retry creation, events/sources/results/exports operations.
- `packages/core/src/research-settings.ts`
  - Feature enablement and resolved runtime limits/provider settings.
- `packages/core/src/db.ts`
  - Research tables: `research_runs`, `research_run_events`, `research_exports`.

### Dashboard API/UI (`@fusion/dashboard`)
- `packages/dashboard/src/research-routes.ts`
  - Research API endpoints (run CRUD + cancel/retry + results/sources/events + exports + finding-to-task actions).
- `packages/dashboard/src/routes/register-integrated-routers.ts`
  - Mounts router at `/api/research` via `router.use("/research", createResearchRouter(store))`.
- `packages/dashboard/app/hooks/useResearch.ts`
  - Dashboard hook consuming `/api/research/*` and run lifecycle updates.
- `packages/dashboard/app/components/ResearchView.tsx`
  - Standalone Research view, run controls, result display, finding task actions.

### Engine (`@fusion/engine`)
- `packages/engine/src/research-orchestrator.ts`
  - Phase execution (`planning/searching/fetching/synthesizing/finalizing`), cancellation, retry handoff, status/event writes.
- `packages/engine/src/research-step-runner.ts`
  - Provider adapters with timeout + abort handling and error classification.

### CLI + extension (`@runfusion/fusion`)
- `packages/cli/src/commands/research.ts`
  - `create`, `list`, `show`, `export`, `cancel`, `retry` commands.
- `packages/cli/src/extension.ts`
  - Research tools: `fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`, `fn_research_retry`.

### Boundary with Insights (separate subsystem)
- Insights files/routes/stores remain separate (`insight-store`, `insights-routes`, `project_insights*` tables).
- Research is **not** a wrapper around Insights and does not share run tables.

## 2) Renamed-path drift and stale assumptions

- Older wording referencing `packages/dashboard/src/routes/register-research-routes.ts` is stale.
- Actual implementation is:
  - route file: `packages/dashboard/src/research-routes.ts`
  - mount file: `packages/dashboard/src/routes/register-integrated-routers.ts`
  - mount path: `/api/research`

## 3) Lifecycle/status contract as shipped

Canonical `ResearchRunStatus` values in `research-types.ts`:
- `queued`
- `running`
- `cancelling`
- `retry_waiting`
- `completed`
- `failed`
- `cancelled`
- `timed_out`
- `retry_exhausted`

### Important mismatch to older baseline text
Older baseline language (`pending | running | completed | failed | cancelled`) is obsolete. `pending` is normalized to `queued` for compatibility in store code, but not a primary status in current contracts.

## 4) Cancel/retry behavior (API + store + orchestrator)

### Dashboard route behavior (`research-routes.ts`)
- `POST /runs/:id/cancel`
  - Rejects terminal statuses (`completed`, `failed`, `cancelled`, `timed_out`, `retry_exhausted`) with `409 INVALID_TRANSITION`.
  - Otherwise calls `ResearchStore.requestCancellation()` → run moves to `cancelling`.
- `POST /runs/:id/retry`
  - Delegates to `ResearchStore.createRetryRun()`.
  - Maps retry exhaustion to `409 RETRY_EXHAUSTED`, non-retryable failures to `409 NON_RETRYABLE_PROVIDER_ERROR`, invalid state to `409 INVALID_TRANSITION`.

### Store behavior (`research-store.ts`)
- `requestCancellation()`
  - Non-terminal runs transition to `cancelling`, append `cancel_requested` lifecycle event.
- `createRetryRun()`
  - Only from `failed`/`timed_out`.
  - Enforces retryable + max-attempt budget; can set source run to `retry_exhausted` and throw `not_retryable`.
  - Creates new run and sets new run status to `retry_waiting` with `retry_scheduled` event.

### Orchestrator behavior (`research-orchestrator.ts`)
- `cancelRun(runId)` always calls `store.requestCancellation(runId)` first.
- If run is active in orchestrator `activeRuns`, abort controller is triggered and final state transitions through cancellation handling.
- If run is **not** active, orchestrator directly sets status `cancelled`.
- Practical limitation: orchestrator-side graceful cancellation logic only applies to runs currently tracked in `activeRuns`.

## 5) Persistence/storage model (verified)

### Tables (`db.ts`)
- `research_runs`
  - Primary run row including JSON columns: `providerConfig`, `sources`, `events`, `results`, `tokenUsage`, `tags`, `metadata`, `lifecycle`.
- `research_run_events`
  - Append-only lifecycle/event stream (`seq`, `type`, `message`, optional status/classification/metadata).
- `research_exports`
  - Export artifacts linked by `runId`.

### Read/write shape (`research-store.ts`)
- Run row stores denormalized snapshots (`sources`, `events`, `results`) in `research_runs` JSON fields.
- Lifecycle events are also persisted separately in `research_run_events` (durable ordered log).
- Results/citations/findings are stored in `research_runs.results` JSON.

## 6) Provider execution path and abort semantics

`research-step-runner.ts`:
- `runSourceQuery` → provider `search(query, options, signal)`
- `runContentFetch` → provider `fetchContent(url, options, signal)`
- `runSynthesis` → configured synthesis runner with model settings + signal

All step calls are wrapped by `withTimeout(...)`:
- timeout classification: `ResearchStepTimeoutError` (`retryable: true`)
- abort classification: `ResearchStepAbortError` (`retryable: false`)
- provider failures: `provider_error` (`retryable: true`)

Abort propagation uses `AbortSignal` listeners and races promise vs timeout vs abort.

## 7) API shape summary (`/api/research`)

Key endpoints:
- `GET /runs`, `POST /runs`, `GET /runs/:id`, `PATCH /runs/:id`, `DELETE /runs/:id`
- `POST /runs/:id/cancel`, `POST /runs/:id/retry`, `PATCH /runs/:id/status`
- `POST /runs/:id/events`, `POST /runs/:id/sources`, `PATCH /runs/:id/sources/:sourceId`, `PUT /runs/:id/results`
- `GET /runs/:id/export`, `POST /runs/:id/exports`, `GET /runs/:id/exports`, `GET /exports/:exportId`
- `GET /stats`, `GET /search`
- `POST /runs/:runId/findings/:findingId/task`
- `POST /runs/:runId/findings/:findingId/tasks/:taskId/enrich`

## 8) Hardening pressure points recorded (no fixes in this task)

1. **Status drift risk**
   - Some surfaces (notably tool parameter enums in extension) still expose legacy compact status sets while core status domain is broader.

2. **Orchestrator cancel scope nuance**
   - Full graceful cancel path is only available when run is in `activeRuns`; non-active cancellation takes direct status path.

3. **Dual event storage model complexity**
   - `research_runs.events` JSON snapshot and `research_run_events` append-only log coexist; hardening should preserve consistency guarantees.

4. **Export surface asymmetry**
   - Route export endpoint advertises markdown/json/html behavior while core export type includes `pdf`; CLI command accepts `pdf` format but markdown renderer fallback behavior should remain explicitly documented/validated.

## 9) FN-3292 boundary stress-test confirmations

- Provider ordering assumptions were tightened: content fetch selection can now use source-level provider metadata (`providerType`) and falls back only when that provider is unavailable.
- Orchestrator/provider seam was validated with behavior-first tests:
  - fallback from failed primary provider to a later provider,
  - partial fetch failure with successful completion when at least one source is fetched,
  - real `ResearchStore` persistence verification at orchestrator level (sources/events/results/lifecycle events persisted end-to-end).
- Boundary guidance for future work:
  - keep retryability/lifecycle ownership in `ResearchStore` transitions,
  - keep error classification in `ResearchStepRunner`,
  - keep sequencing and policy decisions in `ResearchOrchestrator`.

## 10) FN-3370 refinement scope correction

- FN-3370 replaces FN-3015's stale insights-backed child scope with the landed research subsystem surfaces in this document (core `ResearchStore` + dashboard `/api/research` + engine orchestrator lifecycle persistence).
- Regression coverage work should stay bounded to shipped lifecycle/status/export/task-integration contracts and use follow-up tasks for any unshipped behavior instead of feature expansion.

## 11) Dashboard regression coverage status (FN-3368 refinement)

- Dashboard interaction tests are anchored to landed standalone research surfaces (`ResearchView`, `ResearchTaskActionModal`, `useResearch`, `App` research route wiring).
- Route regression tests explicitly cover finding-to-task create/enrich provenance metadata, task-document writes, duplicate-attachment skip behavior, archived/missing target guards, and payload validation.
- There is no placeholder/optional assumption that research dashboard files or `/api/research` routes are absent.

## 12) FN-3369/FN-3599 verification lock note

- Extension research tool contracts are now explicitly locked for missing-run errors and completed-run structured details (`summary`, `findings`, `citations`) across `fn_research_get` / `fn_research_cancel` / `fn_research_retry` behavior.
- Server-level `/api/research` integration assertions are locked through `createServer` coverage for cancel/retry success paths, structured `400`/`404`/`409` envelopes, and export response contract checks.
- CLI routing + docs alignment are locked to shipped behavior, including intentional CLI/core vs server export-format asymmetry documentation (no forced unification).

## 13) Validation references used for this baseline

- `packages/dashboard/src/__tests__/research-routes.test.ts`
- `packages/core/src/__tests__/research-store.test.ts`
- `packages/engine/src/__tests__/research-orchestrator.test.ts`
- `packages/cli/src/commands/__tests__/research.test.ts`

These tests were used as behavioral evidence while preparing this baseline.
