# Research Hardening Preflight + Shape Freeze (FN-3012)

Date: 2026-05-02

## 1) Preflight verdict (dependency check against FN-2998 contract)

**Outcome:** **landed research subsystem present** (with naming drift from the FN-2998 prompt examples).

### Evidence from repository state

Present research-layer files/routes/types:
- `packages/core/src/research-types.ts`
- `packages/core/src/research-store.ts`
- `packages/core/src/research-settings.ts`
- `packages/dashboard/src/research-routes.ts` (**present; named differently than spec example `register-research-routes.ts`**)
- `packages/dashboard/src/__tests__/research-routes.test.ts`
- `packages/dashboard/app/components/ResearchView.tsx`
- `packages/dashboard/app/hooks/useResearch.ts`
- `packages/cli/src/commands/research.ts`
- `packages/cli/src/commands/__tests__/research.test.ts`
- `packages/cli/src/extension.ts` research tool surface (`fn_research_*` tools)
- `packages/engine/src/research-orchestrator.ts`
- `packages/engine/src/research-step-runner.ts`
- `packages/engine/src/research/provider-registry.ts`

Also mounted in dashboard API integration:
- `packages/dashboard/src/routes/register-integrated-routers.ts` mounts `createResearchRouter(store)` at `/api/research`

Database schema is present:
- `packages/core/src/db.ts` includes `research_runs` and `research_exports`
- existing insights schema (`project_insights`, `project_insight_runs`) remains present and separate

### FN-2998 expected-path comparison

Prompt examples that were expected but differ in exact path/name:
- `packages/dashboard/src/routes/register-research-routes.ts` → **actual:** `packages/dashboard/src/research-routes.ts`
- `packages/cli/src/commands/research*` → **actual:** `packages/cli/src/commands/research.ts`
- `packages/core/src/*research*` modules → **actual:** present (`research-types.ts`, `research-store.ts`, `research-settings.ts`)

No blocker condition detected in preflight; dependency is considered landed.

---

## 2) Verified module/file inventory (present vs absent vs speculative)

## 2.1 Core persistence/domain surface

### Present
- `packages/core/src/research-types.ts`
  - Exports: `ResearchRun`, `ResearchRunStatus`, `ResearchSource`, `ResearchResult`, `ResearchExport`, orchestration types (`ResearchOrchestrationConfig`, `ResearchOrchestrationStep`, etc.)
- `packages/core/src/research-store.ts`
  - Class `ResearchStore` with concrete methods:
    - run lifecycle: `createRun`, `getRun`, `updateRun`, `listRuns`, `deleteRun`, `updateStatus`, `retryRun` support via orchestrator
    - run detail mutation: `addEvent`/`appendEvent`, `addSource`, `updateSource`, `setResults`
    - exports: `createExport`, `getExports`, `getExport`
    - discovery/stats: `searchRuns`, `getStats`
- `packages/core/src/store.ts`
  - `TaskStore.getResearchStore()` and `TaskStore.getInsightStore()` both exist; each lazily instantiates separate stores
- `packages/core/src/db.ts`
  - `research_runs`, `research_exports` schema + indexes
  - separate insight tables: `project_insights`, `project_insight_runs`

### Absent
- No unified/merged “research+insight” store class. They are separate stores attached to `TaskStore`.

### Speculative-from-old-contract only
- Any imagined `register-research-routes.ts` location (not present under that name)

## 2.2 Dashboard API surface

### Present
- `packages/dashboard/src/research-routes.ts` (`createResearchRouter`):
  - run endpoints: `GET /runs`, `POST /runs`, `GET /runs/:id`, `POST /runs/:id/cancel`, `POST /runs/:id/retry`, `PATCH /runs/:id`, `DELETE /runs/:id`
  - output endpoints: `GET /runs/:id/export`, `POST /runs/:id/exports`, `GET /runs/:id/exports`, `GET /exports/:exportId`
  - detail endpoints: `POST /runs/:id/events`, `POST /runs/:id/sources`, `PATCH /runs/:id/sources/:sourceId`, `PUT /runs/:id/results`, `PATCH /runs/:id/status`, `GET /stats`, `GET /search`
  - task integration endpoints from FN-2998 chain:
    - `POST /runs/:runId/findings/:findingId/task`
    - `POST /runs/:runId/findings/:findingId/tasks/:taskId/enrich`
- `packages/dashboard/src/routes/register-integrated-routers.ts`
  - mounts research router at `/api/research`
- `packages/dashboard/src/insights-routes.ts`
  - separate insight run/insight CRUD and `/api/insights/run` extraction path

### Absent
- No route file named `register-research-routes.ts`.

### Speculative-only
- Any assumption that research runs are served from `/api/insights/*`.

## 2.3 Dashboard UI/client surface

### Present
- `packages/dashboard/app/components/ResearchView.tsx`
  - Research run create/list/detail actions
  - finding-level task creation/enrichment modal integration
- `packages/dashboard/app/hooks/useResearch.ts`
  - uses `/api/research/*` endpoints via api layer
  - subscribes to SSE run lifecycle events (`research:run:*`) and polling fallback
- `packages/dashboard/app/api/legacy.ts`
  - concrete research bindings under `/research/...` and insight bindings under `/insights/...` (both under `/api` prefix via shared `api()` helper)
- `packages/dashboard/app/App.tsx`
  - lazy-loads `ResearchView` and `InsightsView` separately; each has distinct `taskView` gate

### Absent
- No single combined “ResearchInsightsView”.

### Speculative-only
- assumption that only insights UI exists and research UI is absent (not true in current repo)

## 2.4 Engine automation/orchestration surface

### Present
- `packages/engine/src/research-orchestrator.ts`
  - phased run execution: planning → searching → fetching → synthesizing → finalizing
  - concurrency guard: `AgentSemaphore`
  - cancellation: `cancelRun()` via `AbortController`
  - retry support: `retryRun()`
- `packages/engine/src/research-step-runner.ts`
  - timeout-wrapped provider query/fetch/synthesis with typed error classification
- `packages/engine/src/project-engine.ts`
  - creates `ResearchOrchestrator` when `TaskStore.getResearchStore` exists
  - also independently wires insight extraction automation via cron + memory-insight pipeline

### Absent
- no evidence that insight extraction cron directly writes research run tables.

## 2.5 CLI + extension surface

### Present
- `packages/cli/src/commands/research.ts`
  - commands: run/create, list, show, export, cancel, retry; runtime bootstrap through orchestrator/provider registry
- `packages/cli/src/extension.ts`
  - tools: `fn_research_run`, `fn_research_list`, `fn_research_get`, `fn_research_cancel`
  - separate insight tool family (`fn_insight_*`) coexists

### Absent
- no extra `research-*` command split files; command is consolidated in one module.

---

## 3) Real lifecycle map (entry -> execution -> persistence -> UI)

## 3.1 Research lifecycle (landed)

1. Entry points:
   - Dashboard API: `POST /api/research/runs` (`research-routes.ts`)
   - CLI: `packages/cli/src/commands/research.ts` (`runResearchCreate`)
   - Extension tool: `fn_research_run` in `packages/cli/src/extension.ts`

2. Store creation:
   - `TaskStore.getResearchStore()` -> `ResearchStore.createRun()` writes `research_runs`

3. Orchestration execution:
   - Engine orchestrator (`research-orchestrator.ts`) runs phases with provider-backed `ResearchStepRunner`
   - statuses and events updated through `ResearchStore.updateStatus`/`addEvent`/`addSource`/`setResults`

4. Persistence:
   - run/event/source/result payloads in JSON columns of `research_runs`
   - exports in `research_exports`

5. Consumption/UI:
   - `useResearch.ts` reads `/api/research/runs` + `/api/research/runs/:id`
   - `ResearchView.tsx` displays summary/findings/events, exports, retry/cancel
   - finding actions call:
     - create task: `/api/research/runs/:runId/findings/:findingId/task`
     - enrich task: `/api/research/runs/:runId/findings/:findingId/tasks/:taskId/enrich`

6. Task linkage:
   - provenance uses `sourceType: "research"` and metadata via research route handlers
   - research markdown goes to task documents (`research-{sanitizedRunId}` key)

## 3.2 Adjacent insight lifecycle (still separate and landed)

1. Entry: `POST /api/insights/run` in `insights-routes.ts`
2. AI extraction path: `createFnAgent` + `promptWithFallback` using memory extraction prompt
3. Persistence path: `InsightStore` (`project_insights`, `project_insight_runs`) + memory-insight file updates
4. UI path: `useInsights.ts` + `InsightsView.tsx` and `/api/insights/*`
5. Automation path: project engine startup syncs/schedules insight extraction automation (cron)

---

## 4) Classification decision: standalone, layered, or absent?

**Decision: Research is a standalone landed subsystem that coexists with (and is adjacent to) the insights subsystem, not a thin wrapper over insights.**

Evidence:
- Separate core types/stores (`research-*` vs `insight-*`)
- Separate DB tables (`research_runs/research_exports` vs `project_insights/project_insight_runs`)
- Separate dashboard route families (`/api/research/*` vs `/api/insights/*`)
- Separate dashboard hooks/views (`useResearch` + `ResearchView` vs `useInsights` + `InsightsView`)
- Separate CLI/extension tool families (`research` commands/tools vs `insight` tools)
- Engine contains both research orchestrator path and insight extraction automation path as distinct flows

Relationship note:
- They are **architecturally parallel** subsystems sharing project settings, task store root, and dashboard/engine host infrastructure.

---

## 5) Hardening matrix for FN-3013 through FN-3017 (scope-frozen)

This matrix is bounded to safeguards only (timeouts, cancel, rate limits, error surfaces, regression coverage, verification sequencing).

| Follow-on | Primary lifecycle stage | Exact file targets (first-pass) | Scope guard |
|---|---|---|---|
| FN-3013 | Timeouts + cancellation reliability | `packages/engine/src/research-orchestrator.ts`, `packages/engine/src/research-step-runner.ts`, `packages/engine/src/research/providers/page-fetch-provider.ts`, `packages/engine/src/research/providers/web-search-provider.ts`, `packages/engine/src/research/providers/local-docs-provider.ts`, `packages/engine/src/research/providers/github-provider.ts`, `packages/engine/src/research/providers/llm-synthesis-provider.ts`, `packages/dashboard/src/research-routes.ts`, `packages/cli/src/commands/research.ts`, `packages/cli/src/extension.ts` | No new providers/modules; strengthen abort propagation, timeout classification, and route/CLI cancellation semantics |
| FN-3014 | Rate limiting/backpressure | `packages/engine/src/research-orchestrator.ts`, `packages/engine/src/research/provider-registry.ts`, `packages/engine/src/research/providers/index.ts`, `packages/engine/src/research/providers/page-fetch-provider.ts`, `packages/engine/src/research/providers/web-search-provider.ts`, `packages/engine/src/research/providers/local-docs-provider.ts`, `packages/engine/src/research/providers/github-provider.ts`, `packages/engine/src/research/providers/llm-synthesis-provider.ts`, `packages/engine/src/agent-tools.ts`, `packages/core/src/research-settings.ts`, `packages/core/src/research-types.ts`, settings consumers in `packages/engine/src/project-engine.ts` | Tune and enforce existing limits; avoid adding novel provider architecture |
| FN-3015 | Error surface normalization | `packages/dashboard/src/research-routes.ts`, `packages/dashboard/app/api/legacy.ts`, `packages/dashboard/app/hooks/useResearch.ts`, `packages/dashboard/app/components/ResearchView.tsx`, `packages/cli/src/commands/research.ts`, `packages/cli/src/commands/__tests__/research.test.ts`, `packages/dashboard/src/__tests__/research-routes.test.ts` | Normalize user-facing error payloads/states only; no UX expansion beyond existing view/actions |
| FN-3016 | Regression coverage expansion | `packages/dashboard/src/__tests__/research-routes.test.ts`, `packages/cli/src/commands/__tests__/research.test.ts`, `packages/engine/src/__tests__/research-orchestrator.test.ts`, `packages/engine/src/__tests__/research-step-runner.test.ts`, `packages/engine/src/research/providers/__tests__/*.test.ts` | Add behavior tests around cancellations/timeouts/rate-limits/error mapping |
| FN-3017 | Full verification and integration gate | workspace verification commands + touched tests around research/insights seams | Verify research hardening does not regress insights flows or task integration endpoints |

## sequencing
1. FN-3013 first (cancel/timeout correctness)
2. FN-3014 second (rate/backpressure), because limits interact with cancel behavior
3. FN-3015 third (error contract consistency after behavior stabilizes)
4. FN-3016 fourth (lock regressions)
5. FN-3017 final integration gate

## non-goals (frozen)
- No new research providers
- No new research UI surfaces beyond current ResearchView/task-action flows
- No schema redesign across research/insights
- No migration of insights pipeline into research subsystem

---

## 6) FN-3016 coverage hardening landed

FN-3016 added standalone Research interaction coverage across component/hook/route/app layers using this shape-freeze map.

Primary coverage files:
- `packages/dashboard/app/components/__tests__/ResearchView.test.tsx`
- `packages/dashboard/app/hooks/__tests__/useResearch.test.ts`
- `packages/dashboard/src/__tests__/research-routes.test.ts`
- `packages/dashboard/app/components/__tests__/App.test.tsx`

Covered user-visible flows:
- create-run UX and in-flight/disabled behavior
- loading/empty/error/setup-needed rendering
- run history/search, cited results reading, and detail selection
- export/cancel/retry controls
- finding actions for creating new tasks and enriching existing tasks
- dashboard navigation to standalone Research + feature-disabled fallback/persistence

Bounded fix included by test guidance:
- `ResearchView.handleCreateRun` now clears submitting state before early-return on zero enabled providers (prevents stuck disabled create button).

---

## 7) Blockers status

- **No dependency blocker detected for FN-2998 in current repo state.**
- Existing research subsystem is landed and test-covered (`research-routes.test.ts`, CLI research tests).
- Hardening tasks should target **current concrete files above**, not speculative `register-research-routes.ts` or hypothetical merged insight/research modules.
- Architecture docs were updated in this task to add a dedicated `Research Runs` section and explicit research-vs-insights boundary note (`docs/architecture.md`).

---

## 8) FN-3017 final contract-coverage summary (insights-backed + extension outputs)

FN-3017 added/validated regression coverage for the shipped insights-backed contract and extension structured outputs:

- Dashboard insights route coverage: `packages/dashboard/src/__tests__/insights-routes.test.ts`
  - Added explicit not-found contract assertion for `GET /api/insights/runs/:id` (stable JSON error payload).
  - Existing coverage retained for run trigger/list/show filters, failed runs, and create-task suggestion payload (`POST /api/insights/:id/create-task`).
- Dashboard hook coverage: `packages/dashboard/app/hooks/__tests__/useInsights.test.ts`
  - Added assertion that refresh uses latest run from `fetchInsightRuns` response ordering.
  - Existing coverage retained for failed run error propagation and create-task suggestion mapping.
- Dashboard component coverage: `packages/dashboard/app/components/__tests__/InsightsView.test.tsx`
  - Added run-level failed-state rendering assertion (`runError` alert path) tied to hook state.
- CLI extension structured-output coverage: `packages/cli/src/__tests__/extension.test.ts`
  - Added runnable, CI-safe regression slice (outside env-gated integration block) asserting machine-consumable `details` fields for task creation/dependencies and assignment validation failures.
  - Assertions avoid hardcoded `FN-*` IDs and rely on returned structured metadata.

Bounded production fix landed during this hardening:
- `packages/dashboard/app/hooks/useInsights.ts` now uses `useEffect` for initial refresh side effect (replacing side-effect-in-`useMemo` misuse) to keep hook behavior React-compliant and deterministic.

Final workspace verification on integrated surface completed in FN-3017:
- `pnpm lint`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
