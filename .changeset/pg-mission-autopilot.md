---
"@runfusion/fusion": minor
---

summary: Mission autopilot runs on the PostgreSQL backend — missions advance automatically instead of autopilot being disabled.
category: feature
dev: Await-converts MissionAutopilot to drive MissionStore | AsyncMissionStore (every this.missionStore.* call awaited; watchMission/unwatchMission/getAutopilotStatus and helpers async) and removes the instanceof MissionStore gates in InProcessRuntime (construction + recover paths) so the autopilot loop watches/recomputes/recovers in both backends. Slice execution + validator-loop methods stay scheduler-gated (degrade gracefully in PG). getAutopilotStatus async ripples through mission-routes/server. Adds mission-autopilot.pg.test.ts to test:pg-gate.
