---
"@runfusion/fusion": minor
---

summary: Missions work on the PostgreSQL backend — the Missions dashboard and goal→mission links load instead of erroring.
category: feature
dev: Ports MissionStore (dashboard surface) to the AsyncDataLayer. Adds AsyncMissionStore (63 methods over the 71 existing async helpers + 8 new primitives), assembling the composites (getMissionWithHierarchy, listMissionsWithSummaries, mission/milestone health rollups, computeMissionStatus + the feature→slice→milestone→mission recompute cascade, triageFeature, getFeatureLoopSnapshot) by mirroring the sync store. getMissionStoreImpl returns it in backend mode; mission-routes + goal→mission routes await it and the interim 503 is removed (the GoalStore 503 stays — GoalStore is still deferred). Mission AUTOPILOT, live SSE mission events, mesh hierarchy snapshot apply/collect, and engine validator-loop methods stay degraded in PG mode behind instanceof guards. Also fixes the mission-create path which resolved linked goals via the unported sync GoalStore: goal resolution now degrades to empty in backend mode (links live in MissionStore; full Goal objects return once GoalStore is ported). Adds mission-store.pg.test.ts to test:pg-gate.
