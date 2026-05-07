# fusion-plugin-roadmap

`@fusion-plugin-examples/roadmap` is the workspace package that owns the roadmap plugin boundary used by the roadmap migration.

## Plugin identity

- Manifest id: `fusion-plugin-roadmap`
- Package default export: `definePlugin(...)` manifest object

## Exported roadmap domain surface

The package root exports (re-exported from `@fusion/core`):

- Roadmap domain types
- Ordering helpers
  - `normalizeRoadmapMilestoneOrder`
  - `applyRoadmapMilestoneReorder`
  - `normalizeRoadmapFeatureOrder`
  - `applyRoadmapFeatureReorder`
  - `moveRoadmapFeature`
- Handoff mappers
  - `mapFeatureToTaskHandoff`
  - `mapRoadmapToMissionHandoff`
  - `mapRoadmapWithHierarchyToMissionHandoff`
  - `mapAllFeaturesToTaskHandoffs`
- Store exports
  - `RoadmapStore`
  - `RoadmapStoreEvents`

## Compatibility boundary

This task only backfills the package and export surface expected by migration work. Existing `@fusion/core` and dashboard roadmap consumers intentionally remain in place for now; consumer switchover is deferred to later roadmap-plugin migration tasks.
