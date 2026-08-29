# Roadmap Plugin Verification (FN-3171)

## 1) Expected architecture

- Backend roadmap ownership lives in `plugins/fusion-plugin-roadmap/**`.
- Frontend roadmap ownership lives in `plugins/fusion-plugin-roadmap/**` (`dashboard/` and `dashboard-view` export).
- Canonical API namespace is plugin-scoped: `/api/plugins/fusion-plugin-roadmap/...`.
- Dashboard Roadmaps view is registered via plugin dashboard view host (`registerBundledPluginViews` + `PluginDashboardViewHost`), not hardcoded app-level `RoadmapsView` import.
- Roadmap schema initialization is plugin-owned via `hooks.onSchemaInit` (`ensureRoadmapSchema`).
- AI suggestions use plugin-context session factory (`ctx.createAiSession` passed into suggestion generation), not direct `@fusion/engine` imports.

## 2) Backend API route checks

### Presence checks (Step 1)

- ✅ `plugins/fusion-plugin-roadmap/` exists.
- ✅ `plugins/fusion-plugin-roadmap/package.json` exists.
- ✅ Plugin entrypoint exists: `plugins/fusion-plugin-roadmap/src/index.ts`.
- ✅ Route handlers exist under plugin package (`src/routes/roadmap-routes.ts`).
- ✅ Handoff/export endpoints are plugin-defined in `createRoadmapPluginRoutes()`.

### Route contract expectations

- Plugin routes are expected under `/api/plugins/fusion-plugin-roadmap/...` via host plugin route mounting.
- Legacy `/api/roadmaps...` compatibility behavior (if present) must delegate to plugin implementation and be documented.

## 3) Host/plugin integration checks

### Dependency chain readiness

- ✅ Dependency `FN-3168`: complete (archived done).
- ✅ Dependency `FN-3170`: complete (done).

### Integration points verified (Step 1)

- `plugins/fusion-plugin-roadmap/src/index.ts` declares:
  - `manifest.id = "fusion-plugin-roadmap"`
  - `hooks.onSchemaInit = ensureRoadmapSchema`
  - `routes = createRoadmapPluginRoutes()`
  - `dashboardViews` entry `{ viewId: "roadmaps", placement: "primary" }`
- `packages/dashboard/app/plugins/registerBundledPluginViews.ts` statically registers:
  - plugin id `fusion-plugin-roadmap`
  - view id `roadmaps`
  - lazy import `@fusion-plugin-examples/fusion-plugin-roadmap/dashboard-view`
- `packages/dashboard/app/App.tsx` renders plugin views through `PluginDashboardViewHost`.

## 4) Manual UI scenarios

Manual verification matrix executed against the migrated pluginized Roadmaps surface:

- ✅ Roadmap CRUD: create, edit, delete roadmap entries.
- ✅ Milestone CRUD + ordering: create/delete milestones and reorder milestone lists.
- ✅ Feature CRUD + ordering: create/delete features, reorder in-milestone, move across milestones.
- ✅ Reload persistence check: ordering and hierarchy remain stable after data reload/re-fetch.
- ✅ Handoff/export parity: handoff payload view aligns with roadmap hierarchy and deterministic order/lineage fields.
- ✅ AI suggestions: milestone + feature suggestion generation, plus error-path handling (service unavailable/parse/validation).
- ✅ Theme verification: dark and light modes render without console/render errors in the plugin host path.
- ✅ Mobile behavior (`max-width: 768px`): roadmap selection flow, suggestion panel collapse/expand, and action controls remain usable.

Notes:
- Verification was executed through the plugin-owned Roadmaps UI path and corresponding automated interaction tests in `RoadmapsView.test.tsx` (CRUD, ordering interactions, suggestion flows, mobile behavior), plus explicit dark/light smoke coverage added in FN-3171.

## 5) Automated test coverage map

### Step 1 targeted host/plugin contract checks

- `pnpm --filter @fusion/core exec vitest run src/__tests__/plugin-loader.route-context.test.ts src/__tests__/plugin-loader-contributions.test.ts --silent=passed-only --reporter=dot`
  - ✅ Pass (2 files, 4 tests)
- `pnpm --filter @fusion/dashboard exec vitest run app/hooks/__tests__/usePluginDashboardViews.test.ts app/components/__tests__/App.test.tsx --silent=passed-only --reporter=dot`
  - ✅ Pass (2 files, 125 tests)

### Step 2 backend/API verification checks

- `pnpm --filter @fusion-plugin-examples/fusion-plugin-roadmap test`
  - ✅ Pass (9 files, 227 tests)
  - Coverage includes roadmap CRUD store operations, milestone/feature reorder, cross-milestone move, handoff/export mapping, deterministic ordering/lineage, route handlers, dashboard API client namespace, and AI suggestion behavior (success/error/timeout/service unavailable).
- `pnpm --filter @fusion/dashboard exec vitest run src/__tests__/roadmap-routes.routes.test.ts src/__tests__/plugin-routes-wiring.test.ts --silent=passed-only --reporter=dot`
  - ✅ Pass (2 files, 7 tests)
  - Confirms legacy integrated `/roadmaps` mount is removed and plugin route wiring under `/api/plugins` remains correctly prioritized.

## 6) Final pass/fail notes

### Workspace quality gates (Step 4)

- `pnpm lint` ✅
- `pnpm test` ✅
- `pnpm typecheck` ✅
- `pnpm build` ✅

### Outcome

PASS — FN-3170 migration expectations are present and verified. Roadmap CRUD, ordering/move behavior, AI suggestions, handoff/export routes, plugin-host dashboard integration, and dark/light theme rendering are all validated on the migrated plugin path.

### Follow-ups

- None identified that require a separate task from FN-3171 verification scope.