# fusion-plugin-roadmap

`@fusion-plugin-examples/roadmap` is the workspace package for the bundled `fusion-plugin-roadmap` plugin.

## Plugin identity

- Manifest id: `fusion-plugin-roadmap`
- Route namespace: `/api/plugins/fusion-plugin-roadmap/*`
- Dashboard view: none; the former Roadmaps dashboard view was removed from the app surface.

## Package layout

- `manifest.json` — plugin metadata
- `src/index.ts` — plugin definition (`onSchemaInit`, routes)
- `src/roadmap-schema.ts` — canonical roadmap DDL used by `hooks.onSchemaInit`
- `src/server/index.ts` — backend server exports
- `src/dashboard-view.tsx` — legacy source file retained for compatibility while no package export or dashboard metadata points at it
- `src/dashboard/RoadmapsView.tsx` — plugin-owned roadmap planner page
- `src/dashboard/useRoadmaps.ts` — plugin-owned roadmap CRUD/reorder/suggestions/handoff hook
- `src/dashboard/RoadmapsView.css` — plugin-owned roadmap styles
- `src/dashboard/api.ts` — plugin-local client for `/api/plugins/fusion-plugin-roadmap/*`
- `src/roadmap-types.ts` + `src/store/*` — roadmap domain types/store

## Exported surfaces

- Root export: plugin default + roadmap domain helpers/types
- `./server`: roadmap route + AI suggestion service exports

## Regression test ownership

Roadmap behavior regression tests live in this plugin package and should stay here (not in `@fusion/core` or `@fusion/dashboard`):

- `src/store/__tests__/roadmap-store.test.ts`
- `src/store/__tests__/roadmap-ordering.test.ts`
- `src/store/__tests__/roadmap-handoff.test.ts`
- `src/__tests__/index.test.ts` *(plugin contract: `hooks.onSchemaInit`, no dashboard view metadata registration)*
- `src/__tests__/roadmap-routes.test.ts`
- `src/__tests__/roadmap-suggestions.test.ts` *(AI suggestion flow uses injected `PluginContext.createAiSession()` and session lifecycle handling)*
- `src/__tests__/api-client.test.ts`
- `src/dashboard/__tests__/useRoadmaps.test.ts`
- `src/dashboard/__tests__/RoadmapsView.test.tsx`

Prefer canonical package exports in tests:

- plugin/server surface: `@fusion-plugin-examples/roadmap` or `@fusion-plugin-examples/roadmap/server`

Use deep source imports only when no package export exists for the target module.

## Host vs plugin capability boundaries

Plugin-owned responsibilities:

- Define roadmap schema DDL in `src/roadmap-schema.ts` and register it via `hooks.onSchemaInit` in `src/index.ts`.
- Implement roadmap AI suggestion behavior through the injected `PluginContext.createAiSession()` seam.

Host-owned responsibilities:

- Execute plugin schema hooks during DB startup and expose resulting tables/indexes to plugin routes.
- Inject `createAiSession()` into plugin runtime/route context.
- Keep the roadmap dashboard view hidden if stale plugin dashboard-view metadata appears in persisted data.

## Notes

Roadmap tables are plugin-owned and created via `hooks.onSchemaInit` in `src/index.ts`, which delegates to `src/roadmap-schema.ts`. Core database bootstrap no longer creates roadmap tables/indexes.

Roadmap AI suggestion generation is plugin-owned (`src/roadmap-suggestions.ts` / `src/roadmap-routes.ts`) and uses `PluginContext.createAiSession()` when available. The plugin must not import `@fusion/engine` directly for suggestion generation.
