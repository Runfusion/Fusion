# fusion-plugin-roadmap

`@fusion-plugin-examples/roadmap` is the workspace package for the bundled `fusion-plugin-roadmap` plugin.

## Plugin identity

- Manifest id: `roadmap-planner`
- Route namespace: `/api/plugins/roadmap-planner/*`
- Dashboard view id: `plugin:roadmap-planner:roadmaps`

## Package layout

- `manifest.json` — plugin metadata and dashboard view declaration
- `src/index.ts` — plugin definition (`onSchemaInit`, routes, dashboard view metadata)
- `src/roadmap-schema.ts` — canonical roadmap DDL used by `hooks.onSchemaInit`
- `src/server/index.ts` — backend server exports
- `src/dashboard-view.tsx` — dashboard view entry export for host registration
- `src/dashboard/RoadmapsView.tsx` — plugin-owned roadmap planner page
- `src/dashboard/useRoadmaps.ts` — plugin-owned roadmap CRUD/reorder/suggestions/handoff hook
- `src/dashboard/RoadmapsView.css` — plugin-owned roadmap styles
- `src/dashboard/api.ts` — plugin-local client for `/api/plugins/roadmap-planner/*`
- `src/roadmap-types.ts` + `src/store/*` — roadmap domain types/store

## Exported surfaces

- Root export: plugin default + roadmap domain helpers/types
- `./server`: roadmap route + AI suggestion service exports
- `./dashboard-view`: Roadmaps dashboard view export for host registry wiring

## Regression test ownership

Roadmap behavior regression tests live in this plugin package and should stay here (not in `@fusion/core` or `@fusion/dashboard`):

- `src/store/__tests__/roadmap-store.test.ts`
- `src/store/__tests__/roadmap-ordering.test.ts`
- `src/store/__tests__/roadmap-handoff.test.ts`
- `src/__tests__/roadmap-routes.test.ts`
- `src/__tests__/roadmap-suggestions.test.ts`
- `src/__tests__/api-client.test.ts`
- `src/dashboard/__tests__/useRoadmaps.test.ts`
- `src/dashboard/__tests__/RoadmapsView.test.tsx`

Prefer canonical package exports in tests:

- plugin/server surface: `@fusion-plugin-examples/roadmap` or `@fusion-plugin-examples/roadmap/server`
- dashboard view surface: `@fusion-plugin-examples/roadmap/dashboard-view`

Use deep source imports only when no package export exists for the target module.

## Notes

Roadmap tables are plugin-owned and created via `hooks.onSchemaInit` in `src/index.ts`, which delegates to `src/roadmap-schema.ts`. Core database bootstrap no longer creates roadmap tables/indexes.

Roadmap AI suggestion generation is plugin-owned (`src/roadmap-suggestions.ts` / `src/roadmap-routes.ts`) and uses `PluginContext.createAiSession()` when available. The plugin must not import `@fusion/engine` directly for suggestion generation.

The plugin keeps a single canonical dashboard entrypoint (`./dashboard-view`) and accepts host-supplied dashboard context (`projectId`, optional `addToast`). Do not deep-import dashboard internals from this plugin.
