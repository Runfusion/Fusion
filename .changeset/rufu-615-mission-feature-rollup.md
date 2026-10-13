---
"@runfusion/fusion": patch
---

summary: Missions overview no longer reads every feature row to compute progress counters.
category: performance
dev: `listMissionsWithSummaries` and `listMissionsHealth` now take per-slice SQL rollups
(`rollupFeatureCountsBySlice`, `featureTaskRefs`) instead of `SELECT *` over `mission_features`
followed by JS grouping. Measured on a production board: 114 full-table passes and 25 194
materialised rows per 120 s at 2 526 B average row width. Failure stays a membership decision
against `listFailedTaskIds`, so `tasksFailed` is not aggregated in SQL. Sync `MissionStore` and
`AsyncMissionStore` mirror each other; `packages/core/src/__tests__/mission-rollup-feature-counts.test.ts`
passes unchanged against both implementations.
