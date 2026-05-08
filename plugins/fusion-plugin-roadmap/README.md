# fusion-plugin-roadmap

`@fusion-plugin-examples/roadmap` is the workspace package for the bundled `fusion-plugin-roadmap` plugin.

## Plugin identity

- Manifest id: `fusion-plugin-roadmap`
- Route namespace: `/api/plugins/fusion-plugin-roadmap/*`
- Dashboard view id: `plugin:fusion-plugin-roadmap:roadmaps`

## Package layout

- `manifest.json` — plugin metadata and dashboard view declaration
- `src/index.ts` — plugin definition (`onSchemaInit`, routes, dashboard view metadata)
- `src/server/index.ts` — backend server exports
- `src/dashboard-view.tsx` — dashboard view entry export
- `src/roadmap-types.ts` + `src/store/*` — roadmap domain ownership target (migrated in follow-up steps)

## Exported surfaces

- Root export: plugin default + roadmap domain helpers/types
- `./server`: roadmap route + AI suggestion service exports
- `./dashboard-view`: Roadmaps dashboard view export for host registry wiring

## Notes

The plugin keeps a single canonical ID/path (`fusion-plugin-roadmap`). Do not introduce alternate route namespaces or plugin IDs for this feature.
