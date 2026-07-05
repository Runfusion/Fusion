---
"@runfusion/fusion": patch
---

summary: Fix agent-created artifacts not appearing live in the dashboard artifacts view.
category: fix
dev: Root cause was cross-instance artifact-registration replication, not the route/hook/render path (all already correct). `TaskStore.registerArtifact()` never bumped `lastModified`, and `checkForChanges()` (the polling replicator that lets a second TaskStore instance on the same project — e.g. the dashboard's cached store vs. the engine's own store — mirror events it did not write itself) only ever diffed the `tasks` table, never `artifacts`. A store instance that did not perform the write could therefore never observe or re-emit `artifact:registered`, leaving an already-open Documents/task Artifacts gallery stale until a full reload. Fixed by bumping `lastModified` on artifact writes and adding a strictly-increasing `rowid`-cursor poll over the `artifacts` table in `checkForChanges()`. See `packages/core/src/__tests__/artifacts.test.ts` and `packages/dashboard/src/routes/__tests__/artifacts-route-integration.test.ts` for regression coverage.
